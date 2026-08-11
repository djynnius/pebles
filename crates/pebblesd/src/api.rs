//! The privileged local API, served on the group-gated unix socket. Reachability of
//! the socket IS the authorization boundary today: only root and the `pebbles` group
//! (the web tier) can connect. Per-caller authorization (admin vs user actions)
//! arrives with the session tokens in Phase 1.

use crate::catalog::{self, CatalogError, CatalogInfo};
use crate::cluster::Cluster;
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use pebbles_api::{
    AddMemberRequest, ApiError, CatalogDescriptor, CreateCatalogRequest, CreateGroupRequest,
    CreateUserRequest, EngineAccessRequest, EngineDescriptor, EngineResources, GrantCatalogRequest,
    GroupInfo, Health, IdentitySnapshot, LoginRequest, LoginResponse, MintTokenResponse,
    OpenSessionRequest, RegisterEngineRequest, RegisterEngineResponse, Role, SessionDescriptor,
    TokenInfo, UserInfo, VersionInfo,
};
use pebbles_identity::IdentityError;
use pebbles_session::broker::{Broker, OpenRequest, SessionError, SessionInfo};
use pebbles_session::{AdmissionError, SessionMode};
use serde_json::Value;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    /// `None` when this container doesn't serve sessions (REQ-04 toggle off, or the
    /// kernel binary is absent in a dev run).
    pub broker: Option<Arc<Broker>>,
    pub default_session_memory: u64,
    pub config_dir: std::path::PathBuf,
    pub cluster: Arc<Cluster>,
}

fn health_routes(role: Role) -> Router<AppState> {
    Router::new()
        .route(
            "/healthz",
            get(move || async move {
                Json(Health {
                    status: "ok".to_string(),
                    role,
                })
            }),
        )
        .route(
            "/version",
            get(|| async {
                Json(VersionInfo {
                    version: env!("CARGO_PKG_VERSION").to_string(),
                })
            }),
        )
}

/// The privileged unix-socket API (local, group-gated).
pub fn router(role: Role, state: AppState) -> Router {
    match role {
        // Identity lives on the main (REQ-11); engines receive replicated accounts
        // at registration, they never create them. Sessions are served by the main
        // too while it doubles as the single-box engine (REQ-04).
        Role::Main => health_routes(role)
            .route("/users", get(list_users).post(create_user))
            .route("/auth/login", post(login))
            .route("/sessions", get(list_sessions).post(open_session))
            .route("/sessions/{id}", delete(close_session))
            .route("/sessions/{id}/exec", post(exec_session))
            .route("/catalogs", get(list_catalogs).post(create_catalog))
            .route(
                "/catalogs/{name}/grants",
                get(list_catalog_grants).post(grant_catalog),
            )
            .route("/groups", get(list_groups).post(create_group))
            .route("/groups/{name}/members", post(add_member))
            .route("/groups/{name}/members/{user}", delete(remove_member))
            .route("/cluster/tokens", get(list_tokens).post(mint_token))
            .route("/cluster/tokens/{id}", delete(revoke_token))
            .route("/engines", get(list_engines))
            .route("/engines/{name}/access", post(set_engine_access)),
        Role::Engine => health_routes(role),
    }
    .with_state(state)
}

/// The inter-host cluster API (TCP; bearer-authenticated, TLS pre-v1.0).
pub fn cluster_router(role: Role, state: AppState) -> Router {
    match role {
        Role::Main => health_routes(role)
            .route("/cluster/register", post(register_engine))
            .with_state(state),
        Role::Engine => {
            let guarded = Router::new()
                .route("/engine/sessions", get(list_sessions).post(open_session))
                .route("/engine/sessions/{id}", delete(close_session))
                .route("/engine/sessions/{id}/exec", post(exec_session))
                .route("/engine/sync-accounts", post(sync_accounts))
                .layer(middleware::from_fn_with_state(state.clone(), engine_auth));
            health_routes(role).merge(guarded).with_state(state)
        }
    }
}

/// Inbound main→engine calls must carry the secret issued at registration.
async fn engine_auth(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let want = state
        .cluster
        .engine_self
        .read()
        .unwrap()
        .as_ref()
        .map(|s| s.secret.clone());
    let got = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .map(str::to_string);
    match (want, got) {
        (Some(want), Some(got)) if want == got => next.run(req).await,
        _ => (
            StatusCode::UNAUTHORIZED,
            Json(ApiError {
                error: "missing or invalid cluster secret".into(),
            }),
        )
            .into_response(),
    }
}

type ApiResult<T> = Result<Json<T>, (StatusCode, Json<ApiError>)>;

fn error(status: StatusCode, err: impl ToString) -> (StatusCode, Json<ApiError>) {
    (
        status,
        Json(ApiError {
            error: err.to_string(),
        }),
    )
}

async fn create_user(
    State(state): State<AppState>,
    Json(req): Json<CreateUserRequest>,
) -> ApiResult<UserInfo> {
    if req.password.len() < 8 {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "password must be at least 8 characters",
        ));
    }
    let config_dir = state.config_dir.clone();
    let result = tokio::task::spawn_blocking(move || {
        let user = pebbles_identity::host::create_user(&req.username, &req.password)?;
        // Identity must survive "new image, same volume" upgrades (REQ-09/11).
        if let Err(err) = pebbles_identity::host::persist_users(&config_dir) {
            tracing::error!(%err, "persisting account snapshot failed");
        }
        Ok::<_, IdentityError>(user)
    })
    .await
    .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;

    match result {
        Ok(user) => {
            tracing::info!(user = %user.username, uid = user.uid, "provisioned UNIX account");
            // Replicate to every registered engine (REQ-14); best-effort in the
            // background — engines also reconcile at registration.
            let cluster = state.cluster.clone();
            let dir = state.config_dir.clone();
            tokio::spawn(async move { cluster.push_accounts(&dir).await });
            Ok(Json(UserInfo {
                username: user.username,
                uid: user.uid,
                gid: user.gid,
                home: user.home,
            }))
        }
        Err(e @ IdentityError::InvalidUsername(_)) => {
            Err(error(StatusCode::UNPROCESSABLE_ENTITY, e))
        }
        Err(e @ IdentityError::UserExists(_)) => Err(error(StatusCode::CONFLICT, e)),
        Err(e) => Err(error(StatusCode::INTERNAL_SERVER_ERROR, e)),
    }
}

async fn list_users() -> ApiResult<Vec<UserInfo>> {
    let users = tokio::task::spawn_blocking(pebbles_identity::host::list_users)
        .await
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(
        users
            .into_iter()
            .map(|u| UserInfo {
                username: u.username,
                uid: u.uid,
                gid: u.gid,
                home: u.home,
            })
            .collect(),
    ))
}

async fn login(Json(req): Json<LoginRequest>) -> ApiResult<LoginResponse> {
    let unauthorized = || error(StatusCode::UNAUTHORIZED, "invalid username or password");
    let username = req.username.clone();
    let verified = tokio::task::spawn_blocking(move || {
        pebbles_identity::host::verify_password(&req.username, &req.password)
    })
    .await
    .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;

    match verified {
        Ok(true) => {
            let (uid, _) = pebbles_identity::system_user(&username).ok_or_else(unauthorized)?;
            tracing::info!(user = %username, uid, "login ok");
            Ok(Json(LoginResponse { username, uid }))
        }
        // Wrong password, unknown user, and malformed names all collapse into one
        // answer: no username probing through timing-distinct errors.
        Ok(false) | Err(IdentityError::NoSuchUser(_) | IdentityError::InvalidUsername(_)) => {
            Err(unauthorized())
        }
        Err(e) => Err(error(StatusCode::INTERNAL_SERVER_ERROR, e)),
    }
}

fn describe(info: SessionInfo) -> SessionDescriptor {
    SessionDescriptor {
        id: info.id,
        username: info.username,
        uid: info.uid,
        gid: info.gid,
        pid: info.pid,
        mode: info.mode.as_str().to_string(),
        memory_limit_bytes: info.memory_limit_bytes,
        engine: None,
    }
}

fn session_error(e: SessionError) -> (StatusCode, Json<ApiError>) {
    match &e {
        // Admission refusals are the protocol working (REQ-19/20): a clean 409,
        // never a crash, never a kill.
        SessionError::Admission(
            AdmissionError::MemoryExceeded { .. }
            | AdmissionError::MaxSessions(_)
            | AdmissionError::DedicatedNeedsEmptyEngine(_),
        ) => error(StatusCode::CONFLICT, e),
        SessionError::NotFound(_) => error(StatusCode::NOT_FOUND, e),
        SessionError::Handshake(_) | SessionError::Kernel(_) => error(StatusCode::BAD_GATEWAY, e),
    }
}

fn broker_of(state: &AppState) -> Result<Arc<Broker>, (StatusCode, Json<ApiError>)> {
    state.broker.clone().ok_or_else(|| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "this container does not serve sessions",
        )
    })
}

async fn open_session(
    State(state): State<AppState>,
    Json(req): Json<OpenSessionRequest>,
) -> ApiResult<SessionDescriptor> {
    // Explicit engine choice (REQ-17): a named engine routes the whole session to
    // that engine's pebblesd; the descriptor comes back with a proxy-local id.
    if let Some(name) = req.engine.clone().filter(|n| n != "main") {
        let engine = state
            .cluster
            .engine_by_name(&name)
            .ok_or_else(|| error(StatusCode::NOT_FOUND, format!("no engine {name:?}")))?;
        // REQ-07: only grantees can see or attach the engine.
        let (cluster, user, ename) = (state.cluster.clone(), req.username.clone(), name.clone());
        let allowed = tokio::task::spawn_blocking(move || cluster.engine_allows(&ename, &user))
            .await
            .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
        if !allowed {
            return Err(error(
                StatusCode::FORBIDDEN,
                format!("user {:?} has no access to engine {name:?}", req.username),
            ));
        }
        let forward = OpenSessionRequest {
            engine: None,
            ..req.clone()
        };
        let resp = state
            .cluster
            .http
            .post(format!("{}/engine/sessions", engine.address))
            .bearer_auth(&engine.secret)
            .json(&forward)
            .send()
            .await
            .map_err(|e| error(StatusCode::BAD_GATEWAY, e))?;
        let status =
            StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        if !status.is_success() {
            let err = resp.json::<ApiError>().await.unwrap_or(ApiError {
                error: "engine refused the session".into(),
            });
            return Err((status, Json(err)));
        }
        let mut desc: SessionDescriptor = resp
            .json()
            .await
            .map_err(|e| error(StatusCode::BAD_GATEWAY, e))?;
        desc.id = state.cluster.map_remote(&engine, desc.id);
        desc.engine = Some(name);
        return Ok(Json(desc));
    }

    let broker = broker_of(&state)?;
    let mode = match req.mode.as_deref() {
        None | Some("shared") => SessionMode::Shared,
        Some("dedicated") => SessionMode::Dedicated,
        Some(other) => {
            return Err(error(
                StatusCode::UNPROCESSABLE_ENTITY,
                format!("unknown session mode {other:?}"),
            ))
        }
    };
    let username = req.username.clone();
    let user = tokio::task::spawn_blocking(move || pebbles_identity::host::find_user(&username))
        .await
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| {
            // Only accounts in the reserved range get sessions — root, postgres and
            // friends are structurally excluded.
            error(
                StatusCode::NOT_FOUND,
                format!("no Pebbles user {:?}", req.username),
            )
        })?;

    let info = broker
        .open(OpenRequest {
            username: user.username,
            uid: user.uid,
            gid: user.gid,
            home: user.home,
            mode,
            memory_limit_bytes: req
                .memory_limit_bytes
                .unwrap_or(state.default_session_memory),
        })
        .await
        .map_err(session_error)?;
    Ok(Json(describe(info)))
}

async fn list_sessions(State(state): State<AppState>) -> ApiResult<Vec<SessionDescriptor>> {
    let broker = broker_of(&state)?;
    Ok(Json(broker.list().into_iter().map(describe).collect()))
}

async fn forward_remote(
    state: &AppState,
    remote: &crate::cluster::RemoteRef,
    method: reqwest::Method,
    tail: &str,
    body: Option<&Value>,
) -> ApiResult<Value> {
    let url = format!(
        "{}/engine/sessions/{}{tail}",
        remote.address, remote.remote_id
    );
    let mut call = state
        .cluster
        .http
        .request(method, url)
        .bearer_auth(&remote.secret);
    if let Some(body) = body {
        call = call.json(body);
    }
    let resp = call.send().await.map_err(|e| {
        error(
            StatusCode::BAD_GATEWAY,
            format!("engine {:?} unreachable: {e}", remote.engine_name),
        )
    })?;
    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let value: Value = resp.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        Ok(Json(value))
    } else {
        let msg = value["error"].as_str().unwrap_or("engine call failed");
        Err(error(status, format!("[{}] {msg}", remote.engine_name)))
    }
}

async fn exec_session(
    State(state): State<AppState>,
    Path(id): Path<u64>,
    Json(payload): Json<Value>,
) -> ApiResult<Value> {
    if let Some(remote) = state.cluster.remote_of(id) {
        return forward_remote(
            &state,
            &remote,
            reqwest::Method::POST,
            "/exec",
            Some(&payload),
        )
        .await;
    }
    let broker = broker_of(&state)?;
    Ok(Json(broker.exec(id, payload).await.map_err(session_error)?))
}

async fn close_session(State(state): State<AppState>, Path(id): Path<u64>) -> ApiResult<Value> {
    if let Some(remote) = state.cluster.remote_of(id) {
        let result = forward_remote(&state, &remote, reqwest::Method::DELETE, "", None).await;
        state.cluster.unmap_remote(id);
        return result;
    }
    let broker = broker_of(&state)?;
    broker.close(id).await.map_err(session_error)?;
    Ok(Json(serde_json::json!({ "closed": id })))
}

// ---- cluster handlers ----

async fn mint_token(State(state): State<AppState>) -> ApiResult<MintTokenResponse> {
    let record = state.cluster.mint_token();
    Ok(Json(MintTokenResponse {
        id: record.id,
        token: record.token_hash, // plaintext by construction of mint_token
        expires_at: record.expires_at,
    }))
}

async fn list_tokens(State(state): State<AppState>) -> ApiResult<Vec<TokenInfo>> {
    Ok(Json(
        state
            .cluster
            .tokens
            .lock()
            .unwrap()
            .iter()
            .map(|t| TokenInfo {
                id: t.id.clone(),
                expires_at: t.expires_at,
                used: t.used,
            })
            .collect(),
    ))
}

async fn revoke_token(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult<Value> {
    if state.cluster.revoke_token(&id) {
        Ok(Json(serde_json::json!({ "revoked": id })))
    } else {
        Err(error(StatusCode::NOT_FOUND, format!("no token {id:?}")))
    }
}

async fn register_engine(
    State(state): State<AppState>,
    Json(req): Json<RegisterEngineRequest>,
) -> ApiResult<RegisterEngineResponse> {
    if !req.lake_ok {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "engine cannot reach the lake path (REQ-26) — fix storage before registering",
        ));
    }
    if let Err(conflict) = state.cluster.audit_uids(&req.existing_users) {
        return Err(error(
            StatusCode::CONFLICT,
            format!("uid audit failed, registration refused: {conflict}"),
        ));
    }
    if !state.cluster.consume_token(&req.token) {
        return Err(error(
            StatusCode::UNAUTHORIZED,
            "invalid, used, or expired join token",
        ));
    }
    let config_dir = state.config_dir.clone();
    let identity = tokio::task::spawn_blocking(move || {
        // Make sure the snapshot reflects live accounts before handing it over.
        let _ = pebbles_identity::host::persist_users(&config_dir);
        pebbles_identity::host::read_snapshot(&config_dir)
    })
    .await
    .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?
    .map(|(passwd, shadow, group)| IdentitySnapshot {
        passwd,
        shadow,
        group,
    })
    .unwrap_or(IdentitySnapshot {
        passwd: String::new(),
        shadow: String::new(),
        group: String::new(),
    });

    let record = state.cluster.register_engine(&req);
    tracing::info!(engine = %record.name, address = %record.address, "engine registered");
    Ok(Json(RegisterEngineResponse {
        engine_id: record.id,
        secret: record.secret,
        identity,
    }))
}

async fn sync_accounts(
    State(state): State<AppState>,
    Json(snapshot): Json<IdentitySnapshot>,
) -> ApiResult<Value> {
    let config_dir = state.config_dir.clone();
    let applied = tokio::task::spawn_blocking(move || {
        pebbles_identity::host::apply_snapshot(
            &config_dir,
            &snapshot.passwd,
            &snapshot.shadow,
            &snapshot.group,
        )
    })
    .await
    .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?
    .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(serde_json::json!({ "applied": applied })))
}

// ---- groups & access (M1.2) ----

fn group_info(g: pebbles_identity::PebblesGroup) -> GroupInfo {
    GroupInfo {
        name: g.name,
        gid: g.gid,
        members: g.members,
    }
}

async fn list_groups() -> ApiResult<Vec<GroupInfo>> {
    let groups = tokio::task::spawn_blocking(pebbles_identity::host::list_groups)
        .await
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(groups.into_iter().map(group_info).collect()))
}

async fn create_group(
    State(state): State<AppState>,
    Json(req): Json<CreateGroupRequest>,
) -> ApiResult<GroupInfo> {
    let config_dir = state.config_dir.clone();
    let result = tokio::task::spawn_blocking(move || {
        let group = pebbles_identity::host::create_group(&req.name)?;
        let _ = pebbles_identity::host::persist_users(&config_dir);
        Ok::<_, IdentityError>(group)
    })
    .await
    .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    match result {
        Ok(group) => {
            tracing::info!(group = %group.name, gid = group.gid, "team group created");
            replicate(&state);
            Ok(Json(group_info(group)))
        }
        Err(e @ IdentityError::InvalidUsername(_)) => {
            Err(error(StatusCode::UNPROCESSABLE_ENTITY, e))
        }
        Err(e @ IdentityError::UserExists(_)) => Err(error(StatusCode::CONFLICT, e)),
        Err(e) => Err(error(StatusCode::INTERNAL_SERVER_ERROR, e)),
    }
}

async fn add_member(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(req): Json<AddMemberRequest>,
) -> ApiResult<GroupInfo> {
    let config_dir = state.config_dir.clone();
    let cluster = state.cluster.clone();
    let (group_name, username) = (name.clone(), req.username.clone());
    let result = tokio::task::spawn_blocking(move || {
        pebbles_identity::host::add_member(&group_name, &username)?;
        let _ = pebbles_identity::host::persist_users(&config_dir);
        // If this group already holds catalog grants, wire the new member's
        // Postgres role membership too (sessions pick groups up at next spawn).
        if cluster.catalog_grants_exist_for(&group_name) {
            if let Err(err) = crate::catalog::sync_member(&group_name, &username) {
                tracing::error!(%err, "syncing member into granted catalogs failed");
            }
        }
        let groups = pebbles_identity::host::list_groups()?;
        Ok::<_, IdentityError>(groups.into_iter().find(|g| g.name == group_name))
    })
    .await
    .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    match result {
        Ok(Some(group)) => {
            replicate(&state);
            Ok(Json(group_info(group)))
        }
        Ok(None) => Err(error(StatusCode::NOT_FOUND, format!("no group {name:?}"))),
        Err(e @ IdentityError::NoSuchUser(_)) => Err(error(StatusCode::NOT_FOUND, e)),
        Err(e) => Err(error(StatusCode::INTERNAL_SERVER_ERROR, e)),
    }
}

async fn remove_member(
    State(state): State<AppState>,
    Path((name, user)): Path<(String, String)>,
) -> ApiResult<Value> {
    let config_dir = state.config_dir.clone();
    let (group_name, username) = (name.clone(), user.clone());
    tokio::task::spawn_blocking(move || {
        pebbles_identity::host::remove_member(&group_name, &username)?;
        let _ = pebbles_identity::host::persist_users(&config_dir);
        Ok::<_, IdentityError>(())
    })
    .await
    .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?
    .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    replicate(&state);
    Ok(Json(serde_json::json!({ "removed": user, "group": name })))
}

async fn grant_catalog(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(req): Json<GrantCatalogRequest>,
) -> ApiResult<Value> {
    let group_name = req.group.clone();
    let catalog_name = name.clone();
    let result = tokio::task::spawn_blocking(move || {
        let catalog = crate::catalog::list_catalogs()?
            .into_iter()
            .find(|c| c.name == catalog_name)
            .ok_or(CatalogError::InvalidName(catalog_name.clone()))?;
        let group = pebbles_identity::host::list_groups()
            .map_err(CatalogError::Identity)?
            .into_iter()
            .find(|g| g.name == group_name)
            .ok_or(CatalogError::InvalidName(group_name.clone()))?;
        crate::catalog::grant_catalog(&catalog, &group)
    })
    .await
    .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    match result {
        Ok(()) => {
            state.cluster.record_catalog_grant(&name, &req.group);
            tracing::info!(catalog = %name, group = %req.group, "catalog granted");
            Ok(Json(
                serde_json::json!({ "catalog": name, "group": req.group }),
            ))
        }
        Err(e @ CatalogError::InvalidName(_)) => Err(error(StatusCode::NOT_FOUND, e)),
        Err(e) => Err(error(StatusCode::INTERNAL_SERVER_ERROR, e)),
    }
}

async fn list_catalog_grants(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> ApiResult<Vec<String>> {
    Ok(Json(state.cluster.catalog_grants(&name)))
}

async fn set_engine_access(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(req): Json<EngineAccessRequest>,
) -> ApiResult<Value> {
    let valid = req.access == "everyone" || req.access.starts_with("group:");
    if !valid {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "access must be \"everyone\" or \"group:<name>\"",
        ));
    }
    state.cluster.set_engine_access(&name, &req.access);
    tracing::info!(engine = %name, access = %req.access, "engine access set");
    Ok(Json(
        serde_json::json!({ "engine": name, "access": req.access }),
    ))
}

/// Fire-and-forget identity replication after any identity mutation (REQ-14).
fn replicate(state: &AppState) {
    let cluster = state.cluster.clone();
    let dir = state.config_dir.clone();
    tokio::spawn(async move { cluster.push_accounts(&dir).await });
}

async fn list_engines(State(state): State<AppState>) -> ApiResult<Vec<EngineDescriptor>> {
    let mut engines = Vec::new();
    if state.broker.is_some() {
        engines.push(EngineDescriptor {
            name: "main".into(),
            address: "local".into(),
            state: "available".into(),
            resources: EngineResources {
                cpus: std::thread::available_parallelism()
                    .map(|n| n.get() as u32)
                    .unwrap_or(1),
                memory_bytes: 0,
            },
            access: Some(state.cluster.engine_access("main")),
        });
    }
    for record in state.cluster.list_engines() {
        let alive = state
            .cluster
            .http
            .get(format!("{}/healthz", record.address))
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false);
        let access = Some(state.cluster.engine_access(&record.name));
        engines.push(EngineDescriptor {
            name: record.name,
            address: record.address,
            state: if alive { "available" } else { "stopped" }.into(),
            resources: record.resources,
            access,
        });
    }
    Ok(Json(engines))
}

fn describe_catalog(info: CatalogInfo) -> CatalogDescriptor {
    let sql = catalog::equivalent_sql(&info.name);
    CatalogDescriptor {
        name: info.name,
        owner: info.owner,
        database: info.database,
        data_path: info.data_path,
        sql,
    }
}

fn catalog_error(e: CatalogError) -> (StatusCode, Json<ApiError>) {
    match &e {
        CatalogError::InvalidName(_) => error(StatusCode::UNPROCESSABLE_ENTITY, e),
        CatalogError::Exists(_) => error(StatusCode::CONFLICT, e),
        CatalogError::NoPostgres => error(StatusCode::SERVICE_UNAVAILABLE, e),
        _ => error(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn create_catalog(Json(req): Json<CreateCatalogRequest>) -> ApiResult<CatalogDescriptor> {
    let owner_name = req.owner.clone();
    let owner = tokio::task::spawn_blocking(move || pebbles_identity::host::find_user(&owner_name))
        .await
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| {
            error(
                StatusCode::NOT_FOUND,
                format!("no Pebbles user {:?}", req.owner),
            )
        })?;
    let info = tokio::task::spawn_blocking(move || catalog::create_catalog(&req.name, &owner))
        .await
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .map_err(catalog_error)?;
    tracing::info!(catalog = %info.name, owner = %info.owner, "catalog created");
    Ok(Json(describe_catalog(info)))
}

async fn list_catalogs() -> ApiResult<Vec<CatalogDescriptor>> {
    let catalogs = tokio::task::spawn_blocking(catalog::list_catalogs)
        .await
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .map_err(catalog_error)?;
    Ok(Json(catalogs.into_iter().map(describe_catalog).collect()))
}
