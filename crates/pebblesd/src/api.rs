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
    CreateUserRequest, EngineAccessRequest, EngineDescriptor, EngineResources, EngineStatus,
    GrantCatalogRequest, GroupInfo, Health, IdentitySnapshot, LoginRequest, LoginResponse,
    MintTokenResponse, OpenSessionRequest, RegisterEngineRequest, RegisterEngineResponse,
    ReservationDescriptor, ReservationStatus, Role, SessionDescriptor, TokenInfo, UserInfo,
    VersionInfo,
};
use pebbles_identity::IdentityError;
use pebbles_session::broker::{
    Broker, EngineState, OpenOutcome, OpenRequest, SessionError, SessionInfo,
};
use pebbles_session::{AdmissionError, SessionMode};
use serde_json::Value;
use std::sync::Arc;
use tokio_stream::StreamExt;

#[derive(Clone)]
pub struct AppState {
    /// `None` when this container doesn't serve sessions (REQ-04 toggle off, or the
    /// kernel binary is absent in a dev run).
    pub broker: Option<Arc<Broker>>,
    pub default_session_memory: u64,
    pub config_dir: std::path::PathBuf,
    pub cluster: Arc<Cluster>,
    /// This container's own cluster-TLS cert fingerprint (NFR-02) — handed to
    /// engines at registration so they can pin us.
    pub cluster_cert_fp: Option<String>,
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
            .route(
                "/sessions/reservation",
                get(reservation_status).delete(cancel_reservation),
            )
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
            .route("/engines/{name}/access", post(set_engine_access))
            .route("/engines/{name}", delete(deregister_engine))
            .route("/engines/pending", get(list_pending))
            .route("/engines/pending/{name}/approve", post(approve_pending))
            .route("/engines/pending/{name}", delete(reject_pending))
            .route("/usage", get(usage))
            .route("/workflows", get(list_workflows).post(save_workflow))
            .route("/workflows/{name}/run", post(trigger_workflow))
            .route("/workflows/{name}/runs", get(workflow_runs))
            .route("/workflows/{name}/runs/{run_id}", get(workflow_run_detail))
            .route("/nkoyo/config", get(nkoyo_config).post(nkoyo_config_save))
            .route("/nkoyo/rescan", post(nkoyo_rescan))
            .route("/nkoyo/chat", post(nkoyo_chat)),
        Role::Engine => health_routes(role),
    }
    .with_state(state)
}

/// The inter-host cluster API (TLS, NFR-02; bearer-authenticated).
pub fn cluster_router(role: Role, state: AppState) -> Router {
    match role {
        Role::Main => health_routes(role)
            .route("/cluster/register", post(register_engine))
            .with_state(state),
        Role::Engine => {
            let guarded = Router::new()
                .route("/engine/sessions", get(list_sessions).post(open_session))
                .route(
                    "/engine/sessions/reservation",
                    get(reservation_status).delete(cancel_reservation),
                )
                .route("/engine/sessions/{id}", delete(close_session))
                .route("/engine/sessions/{id}/exec", post(exec_session))
                .route("/engine/state", get(engine_state))
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
        // M2.5b: catalog TCP credential (~/.pgpass) for remote-engine attaches.
        // Best-effort — postgres may still be starting on first boot; the
        // grant/catalog hooks re-try it lazily.
        if let Err(err) = crate::catalog::ensure_pg_password(&user.username) {
            tracing::warn!(%err, "pg password provisioning deferred");
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
        // Admission/drain refusals are the protocol working (REQ-19/20): a clean
        // 409, never a crash, never a kill.
        SessionError::Admission(
            AdmissionError::MemoryExceeded { .. }
            | AdmissionError::MaxSessions(_)
            | AdmissionError::DedicatedNeedsEmptyEngine(_),
        )
        | SessionError::Draining(_)
        | SessionError::ReservationHeld(_) => error(StatusCode::CONFLICT, e),
        SessionError::DedicatedDisabled => error(StatusCode::FORBIDDEN, e),
        SessionError::NotFound(_) => error(StatusCode::NOT_FOUND, e),
        SessionError::Handshake(_) | SessionError::Kernel(_) => error(StatusCode::BAD_GATEWAY, e),
    }
}

fn reservation_view(broker: &Broker) -> ReservationStatus {
    match broker.reservation_status() {
        None => ReservationStatus {
            state: "none".into(),
            reservation: None,
            session: None,
        },
        Some((view, ready)) => ReservationStatus {
            state: if ready.is_some() { "ready" } else { "pending" }.into(),
            reservation: Some(ReservationDescriptor {
                username: view.username,
                waited_secs: view.waited_secs,
                notified: view.notified,
                engine: None,
            }),
            session: ready.map(describe),
        },
    }
}

async fn reservation_status(
    State(state): State<AppState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> ApiResult<ReservationStatus> {
    if let Some(name) = params.get("engine").filter(|n| n.as_str() != "main") {
        let engine = state
            .cluster
            .engine_by_name(name)
            .ok_or_else(|| error(StatusCode::NOT_FOUND, format!("no engine {name:?}")))?;
        let resp = state
            .cluster
            .peer_client(engine.cert_fp.as_deref())
            .get(format!("{}/engine/sessions/reservation", engine.address))
            .bearer_auth(&engine.secret)
            .send()
            .await
            .map_err(|e| error(StatusCode::BAD_GATEWAY, e))?;
        let status: ReservationStatus = resp
            .json()
            .await
            .map_err(|e| error(StatusCode::BAD_GATEWAY, e))?;
        return Ok(Json(status));
    }
    let broker = broker_of(&state)?;
    Ok(Json(reservation_view(&broker)))
}

async fn cancel_reservation(
    State(state): State<AppState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> ApiResult<Value> {
    if let Some(name) = params.get("engine").filter(|n| n.as_str() != "main") {
        let engine = state
            .cluster
            .engine_by_name(name)
            .ok_or_else(|| error(StatusCode::NOT_FOUND, format!("no engine {name:?}")))?;
        let resp = state
            .cluster
            .peer_client(engine.cert_fp.as_deref())
            .delete(format!("{}/engine/sessions/reservation", engine.address))
            .bearer_auth(&engine.secret)
            .send()
            .await
            .map_err(|e| error(StatusCode::BAD_GATEWAY, e))?;
        let value: Value = resp.json().await.unwrap_or(Value::Null);
        return Ok(Json(value));
    }
    let broker = broker_of(&state)?;
    Ok(Json(
        serde_json::json!({ "cancelled": broker.cancel_reservation() }),
    ))
}

fn state_string(state: &EngineState) -> String {
    match state {
        EngineState::Available => "available".into(),
        EngineState::InUse(_) => "in use".into(),
        EngineState::Draining(user) => format!("draining (reserved for {user})"),
        EngineState::Dedicated(user) => format!("dedicated to {user}"),
    }
}

async fn engine_state(State(state): State<AppState>) -> ApiResult<EngineStatus> {
    let broker = broker_of(&state)?;
    Ok(Json(EngineStatus {
        state: state_string(&broker.state()),
        sessions: broker.list().len() as u64,
    }))
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
) -> Result<Response, (StatusCode, Json<ApiError>)> {
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
            .peer_client(engine.cert_fp.as_deref())
            .post(format!("{}/engine/sessions", engine.address))
            .bearer_auth(&engine.secret)
            .json(&forward)
            .send()
            .await
            .map_err(|e| error(StatusCode::BAD_GATEWAY, e))?;
        let status =
            StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        if status == StatusCode::ACCEPTED {
            // A drain started on the engine (REQ-19); relay the reservation.
            let mut reservation: ReservationDescriptor = resp
                .json()
                .await
                .map_err(|e| error(StatusCode::BAD_GATEWAY, e))?;
            reservation.engine = Some(name);
            return Ok((StatusCode::ACCEPTED, Json(reservation)).into_response());
        }
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
        return Ok(Json(desc).into_response());
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

    let outcome = broker
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
    Ok(match outcome {
        OpenOutcome::Session(info) => Json(describe(info)).into_response(),
        // 202: the drain began; the caller polls /sessions/reservation (REQ-19).
        OpenOutcome::Reserved(view) => (
            StatusCode::ACCEPTED,
            Json(ReservationDescriptor {
                username: view.username,
                waited_secs: view.waited_secs,
                notified: view.notified,
                engine: None,
            }),
        )
            .into_response(),
    })
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
        .peer_client(remote.cert_fp.as_deref())
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
) -> Response {
    // sql_stream (REQ-31): progressive rows as an NDJSON body — one JSON per
    // line, terminal line carries "done": true. Everything else stays a single
    // JSON response.
    if payload.get("op").and_then(Value::as_str) == Some("sql_stream") {
        return exec_session_stream(state, id, payload).await;
    }
    if let Some(remote) = state.cluster.remote_of(id) {
        return forward_remote(
            &state,
            &remote,
            reqwest::Method::POST,
            "/exec",
            Some(&payload),
        )
        .await
        .into_response();
    }
    let broker = match broker_of(&state) {
        Ok(b) => b,
        Err(e) => return e.into_response(),
    };
    match broker.exec(id, payload).await.map_err(session_error) {
        Ok(v) => Json(v).into_response(),
        Err(e) => e.into_response(),
    }
}

/// The streaming leg of exec_session: local sessions relay the broker's line
/// channel; remote sessions relay the engine's NDJSON body bytes unparsed.
async fn exec_session_stream(state: AppState, id: u64, payload: Value) -> Response {
    use axum::body::Body;
    let ndjson = [(axum::http::header::CONTENT_TYPE, "application/x-ndjson")];

    if let Some(remote) = state.cluster.remote_of(id) {
        let url = format!(
            "{}/engine/sessions/{}/exec",
            remote.address, remote.remote_id
        );
        let resp = state
            .cluster
            .peer_client(remote.cert_fp.as_deref())
            .post(url)
            .bearer_auth(&remote.secret)
            .json(&payload)
            .send()
            .await;
        return match resp {
            Ok(resp) if resp.status().is_success() => {
                (ndjson, Body::from_stream(resp.bytes_stream())).into_response()
            }
            Ok(resp) => error(
                StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
                format!("[{}] stream refused", remote.engine_name),
            )
            .into_response(),
            Err(e) => error(StatusCode::BAD_GATEWAY, e).into_response(),
        };
    }

    let broker = match broker_of(&state) {
        Ok(b) => b,
        Err(e) => return e.into_response(),
    };
    let (tx, rx) = tokio::sync::mpsc::channel::<Value>(16);
    tokio::spawn(async move {
        if let Err(err) = broker.exec_stream(id, payload, tx.clone()).await {
            // Surface broker-level failures as a terminal line so the client
            // never hangs waiting for "done".
            let _ = tx
                .send(serde_json::json!({
                    "ok": false, "done": true, "error": err.to_string()
                }))
                .await;
        }
    });
    let stream = tokio_stream::wrappers::ReceiverStream::new(rx)
        .map(|v| Ok::<_, std::convert::Infallible>(format!("{v}\n")));
    (ndjson, Body::from_stream(stream)).into_response()
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

/// The current identity snapshot, refreshed from live accounts first (REQ-14).
async fn identity_snapshot(
    config_dir: std::path::PathBuf,
) -> Result<IdentitySnapshot, (StatusCode, Json<ApiError>)> {
    tokio::task::spawn_blocking(move || {
        // Make sure the snapshot reflects live accounts before handing it over.
        let _ = pebbles_identity::host::persist_users(&config_dir);
        pebbles_identity::host::read_snapshot(&config_dir)
    })
    .await
    .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))
    .map(|snap| {
        snap.map(|(passwd, shadow, group)| IdentitySnapshot {
            passwd,
            shadow,
            group,
        })
        .unwrap_or(IdentitySnapshot {
            passwd: String::new(),
            shadow: String::new(),
            group: String::new(),
        })
    })
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
    // Reconcile (NFR-08/REQ-14): a known engine proves itself with id + secret
    // — record refreshed, same secret, current identity snapshot returned. An
    // unknown pair falls through to the token / pending-approval path below.
    if req.engine_id.is_some() {
        if let Some(record) = state.cluster.reregister(&req) {
            let identity = identity_snapshot(state.config_dir.clone()).await?;
            return Ok(Json(RegisterEngineResponse {
                engine_id: record.id,
                secret: record.secret,
                identity,
                main_cert_fp: state.cluster_cert_fp.clone(),
            }));
        }
        tracing::warn!(
            engine = %req.name,
            "re-registration with unknown id/secret — treating as a new engine"
        );
    }
    if req.token.is_empty() {
        // Tokenless contact (REQ-06): pending until an admin approves; the
        // engine keeps retrying and completes registration once approved.
        if !state.cluster.note_pending(&req) {
            return Err(error(
                StatusCode::ACCEPTED,
                format!("engine {:?} is pending admin approval", req.name),
            ));
        }
        tracing::info!(engine = %req.name, "pending engine approved; completing registration");
    } else if !state.cluster.consume_token(&req.token) {
        return Err(error(
            StatusCode::UNAUTHORIZED,
            "invalid, used, or expired join token",
        ));
    }
    let identity = identity_snapshot(state.config_dir.clone()).await?;

    let record = state.cluster.register_engine(&req);
    tracing::info!(engine = %record.name, address = %record.address, "engine registered");
    Ok(Json(RegisterEngineResponse {
        engine_id: record.id,
        secret: record.secret,
        identity,
        main_cert_fp: state.cluster_cert_fp.clone(),
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

// ---- admin completeness (M1.8, REQ-06/08/48) ----

async fn deregister_engine(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> ApiResult<Value> {
    if state.cluster.deregister(&name) {
        tracing::info!(engine = %name, "engine deregistered; credentials invalidated");
        Ok(Json(serde_json::json!({ "deregistered": name })))
    } else {
        Err(error(StatusCode::NOT_FOUND, format!("no engine {name:?}")))
    }
}

async fn list_pending(
    State(state): State<AppState>,
) -> ApiResult<Vec<pebbles_api::PendingEngineInfo>> {
    Ok(Json(
        state
            .cluster
            .list_pending()
            .into_iter()
            .map(|p| pebbles_api::PendingEngineInfo {
                name: p.name,
                address: p.address,
                cpus: p.resources.cpus,
                first_seen: p.first_seen,
                approved: p.approved,
            })
            .collect(),
    ))
}

async fn approve_pending(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> ApiResult<Value> {
    if state.cluster.resolve_pending(&name, true) {
        Ok(Json(serde_json::json!({ "approved": name })))
    } else {
        Err(error(
            StatusCode::NOT_FOUND,
            format!("no pending engine {name:?}"),
        ))
    }
}

async fn reject_pending(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> ApiResult<Value> {
    if state.cluster.resolve_pending(&name, false) {
        Ok(Json(serde_json::json!({ "rejected": name })))
    } else {
        Err(error(
            StatusCode::NOT_FOUND,
            format!("no pending engine {name:?}"),
        ))
    }
}

fn disk_usage(mount: &str) -> Option<pebbles_api::DiskUsage> {
    let c_mount = std::ffi::CString::new(mount).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: valid CString pointer and zeroed out-struct.
    if unsafe { libc::statvfs(c_mount.as_ptr(), &mut stat) } != 0 {
        return None;
    }
    Some(pebbles_api::DiskUsage {
        mount: mount.to_string(),
        total_bytes: stat.f_blocks as u64 * stat.f_frsize as u64,
        free_bytes: stat.f_bavail as u64 * stat.f_frsize as u64,
    })
}

/// Host resources (REQ-48): CPU load, memory, disks — never "credits".
async fn usage(State(state): State<AppState>) -> ApiResult<pebbles_api::UsageInfo> {
    let meminfo = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let mem = |key: &str| -> u64 {
        meminfo
            .lines()
            .find(|l| l.starts_with(key))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0)
            * 1024
    };
    let loadavg = std::fs::read_to_string("/proc/loadavg").unwrap_or_default();
    let mut load = loadavg.split_whitespace().map(|v| v.parse().unwrap_or(0.0));
    let mut disks: Vec<_> = ["/", "/home"]
        .iter()
        .filter_map(|m| disk_usage(m))
        .collect();
    if let Some(cfg) = state.config_dir.to_str() {
        disks.extend(disk_usage(cfg));
    }
    Ok(Json(pebbles_api::UsageInfo {
        hostname: std::fs::read_to_string("/etc/hostname")
            .unwrap_or_default()
            .trim()
            .to_string(),
        cpus: std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(1),
        load_1: load.next().unwrap_or(0.0),
        load_5: load.next().unwrap_or(0.0),
        load_15: load.next().unwrap_or(0.0),
        mem_total_bytes: mem("MemTotal"),
        mem_available_bytes: mem("MemAvailable"),
        disks,
    }))
}

// ---- Nkoyo: local-model assistant (Phase 2, REQ-43) ----

async fn nkoyo_config(State(state): State<AppState>) -> ApiResult<crate::nkoyo::NkoyoConfig> {
    Ok(Json(crate::nkoyo::load(&state.config_dir)))
}

async fn nkoyo_config_save(
    State(state): State<AppState>,
    Json(cfg): Json<crate::nkoyo::NkoyoConfig>,
) -> ApiResult<crate::nkoyo::NkoyoConfig> {
    crate::nkoyo::save(&state.config_dir, &cfg)
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    tracing::info!(endpoints = cfg.endpoints.len(), "nkoyo config saved");
    Ok(Json(cfg))
}

/// Probe the fleet for Ollama endpoints (REQ-43 auto-detect + manual rescan).
async fn nkoyo_rescan(
    State(state): State<AppState>,
) -> ApiResult<Vec<crate::nkoyo::DetectedEndpoint>> {
    let engine_addresses: Vec<String> = state
        .cluster
        .list_engines()
        .into_iter()
        .map(|e| e.address)
        .collect();
    let mut found = Vec::new();
    for candidate in crate::nkoyo::candidates(&engine_addresses) {
        if let Some(detected) = crate::nkoyo::probe(&state.cluster.http, &candidate).await {
            found.push(detected);
        }
    }
    Ok(Json(found))
}

#[derive(serde::Deserialize)]
struct NkoyoChatBody {
    /// The signed-in user — tools run in THEIR session, so Nkoyo is bounded by
    /// their grants (REQ-45).
    username: String,
    messages: Vec<crate::nkoyo::ChatMessage>,
    /// Tools the user pre-authorized this turn (for ask-first grades).
    #[serde(default)]
    approved: Vec<String>,
}

async fn nkoyo_chat(
    State(state): State<AppState>,
    Json(body): Json<NkoyoChatBody>,
) -> ApiResult<Value> {
    let cfg = crate::nkoyo::load(&state.config_dir);

    // Resolve the user and open a session for the agent's tools (REQ-45).
    let username = body.username.clone();
    let user = tokio::task::spawn_blocking(move || pebbles_identity::host::find_user(&username))
        .await
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "unknown user"))?;

    let skills = crate::nkoyo::load_skills(std::path::Path::new(&user.home));
    let system = crate::nkoyo::system_prompt(&body.username, &skills);

    // A transient session hosts the agent's tool calls; None → no tools, plain chat.
    let broker = state.broker.clone();
    let session = if let Some(broker) = &broker {
        broker
            .open(OpenRequest {
                username: user.username.clone(),
                uid: user.uid,
                gid: user.gid,
                home: user.home.clone(),
                mode: SessionMode::Shared,
                memory_limit_bytes: state.default_session_memory,
            })
            .await
            .ok()
            .and_then(|o| match o {
                OpenOutcome::Session(info) => Some(info.id),
                OpenOutcome::Reserved(_) => None,
            })
    } else {
        None
    };

    let run_op = |op: Value| {
        let broker = broker.clone();
        async move {
            // Catalog listing is pebblesd-level metadata, not a kernel op.
            if op["op"] == "list_catalogs" {
                let catalogs = tokio::task::spawn_blocking(catalog::list_catalogs)
                    .await
                    .map_err(|e| e.to_string())?
                    .map_err(|e| e.to_string())?;
                let names: Vec<&str> = catalogs.iter().map(|c| c.name.as_str()).collect();
                return Ok(serde_json::json!({"ok": true, "catalogs": names}));
            }
            match (broker, session) {
                (Some(broker), Some(sid)) => broker.exec(sid, op).await.map_err(|e| e.to_string()),
                _ => Err("no engine session available for tools".to_string()),
            }
        }
    };

    let result = crate::nkoyo::agent_turn(
        &state.cluster.http,
        &cfg,
        &system,
        &body.messages,
        &body.approved,
        run_op,
    )
    .await;

    if let (Some(broker), Some(sid)) = (&broker, session) {
        let _ = broker.close(sid).await;
    }

    match result {
        Ok((content, trace)) => Ok(Json(serde_json::json!({
            "content": content,
            "model": cfg.planner_model,
            "tools_used": trace,
        }))),
        Err(msg) if msg.starts_with("no Ollama endpoints") => Err(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "no Ollama endpoints configured — add one under Settings → Nkoyo \
             (models run locally; nothing leaves your hosts)",
        )),
        Err(msg) => Err(error(StatusCode::BAD_GATEWAY, msg)),
    }
}

// ---- jobs on hidden Airflow (M1.6, REQ-38..42) ----

fn jobs_error(e: crate::jobs::JobsError) -> (StatusCode, Json<ApiError>) {
    use crate::jobs::JobsError;
    match &e {
        JobsError::InvalidName(_) | JobsError::InvalidTask(_) => {
            error(StatusCode::UNPROCESSABLE_ENTITY, e)
        }
        JobsError::NotFound(_) => error(StatusCode::NOT_FOUND, e),
        JobsError::NoAirflow => error(StatusCode::SERVICE_UNAVAILABLE, e),
        _ => error(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn save_workflow(
    State(state): State<AppState>,
    Json(wf): Json<crate::jobs::Workflow>,
) -> ApiResult<crate::jobs::Workflow> {
    // The workflow owner must be a real Pebbles user — tasks run as them (REQ-41).
    let owner = wf.username.clone();
    let exists = tokio::task::spawn_blocking(move || pebbles_identity::host::find_user(&owner))
        .await
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    if exists.is_none() {
        return Err(error(
            StatusCode::NOT_FOUND,
            format!("no Pebbles user {:?}", wf.username),
        ));
    }
    let dir = state.config_dir.clone();
    let saved = wf.clone();
    tokio::task::spawn_blocking(move || crate::jobs::save(&dir, &saved))
        .await
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .map_err(jobs_error)?;
    tracing::info!(workflow = %wf.name, owner = %wf.username, "workflow saved and compiled");
    Ok(Json(wf))
}

async fn list_workflows(State(state): State<AppState>) -> ApiResult<Vec<crate::jobs::Workflow>> {
    let dir = state.config_dir.clone();
    let flows = tokio::task::spawn_blocking(move || crate::jobs::list(&dir))
        .await
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .map_err(jobs_error)?;
    Ok(Json(flows))
}

async fn trigger_workflow(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> ApiResult<Value> {
    let dir = state.config_dir.clone();
    let flow_name = name.clone();
    tokio::task::spawn_blocking(move || crate::jobs::trigger(&dir, &flow_name))
        .await
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .map_err(jobs_error)?;
    Ok(Json(serde_json::json!({ "triggered": name })))
}

async fn workflow_runs(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> ApiResult<Vec<crate::jobs::RunInfo>> {
    let dir = state.config_dir.clone();
    let runs = tokio::task::spawn_blocking(move || crate::jobs::runs(&dir, &name))
        .await
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .map_err(jobs_error)?;
    Ok(Json(runs))
}

async fn workflow_run_detail(
    State(state): State<AppState>,
    Path((name, run_id)): Path<(String, String)>,
) -> ApiResult<Vec<crate::jobs::TaskRunInfo>> {
    let dir = state.config_dir.clone();
    let detail = tokio::task::spawn_blocking(move || crate::jobs::run_detail(&dir, &name, &run_id))
        .await
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .map_err(jobs_error)?;
    Ok(Json(detail))
}

async fn list_engines(State(state): State<AppState>) -> ApiResult<Vec<EngineDescriptor>> {
    let mut engines = Vec::new();
    if let Some(broker) = &state.broker {
        engines.push(EngineDescriptor {
            name: "main".into(),
            address: "local".into(),
            state: state_string(&broker.state()),
            resources: EngineResources {
                cpus: std::thread::available_parallelism()
                    .map(|n| n.get() as u32)
                    .unwrap_or(1),
                memory_bytes: 0,
            },
            access: Some(state.cluster.engine_access("main")),
            sessions: broker.list().len() as u64,
        });
    }
    for record in state.cluster.list_engines() {
        // REQ-22/23: state comes from the health loop's cache — instant, and
        // "lost" (unreachable for 3 probes) is distinct from an engine's own
        // "stopped". Only an engine the loop hasn't observed yet (registered
        // seconds ago) gets one inline probe.
        let status = match state.cluster.engine_health(&record.name) {
            Some((engine_state, sessions)) => EngineStatus {
                state: engine_state,
                sessions,
            },
            None => {
                let probe = state
                    .cluster
                    .peer_client(record.cert_fp.as_deref())
                    .get(format!("{}/engine/state", record.address))
                    .bearer_auth(&record.secret)
                    .timeout(std::time::Duration::from_secs(2))
                    .send()
                    .await;
                let observed = match probe {
                    Ok(resp) if resp.status().is_success() => resp
                        .json::<EngineStatus>()
                        .await
                        .ok()
                        .map(|s| (s.state, s.sessions)),
                    _ => None,
                };
                state.cluster.note_probe(&record.name, observed.clone());
                let (engine_state, sessions) = observed.unwrap_or_else(|| ("stopped".into(), 0));
                EngineStatus {
                    state: engine_state,
                    sessions,
                }
            }
        };
        let access = Some(state.cluster.engine_access(&record.name));
        engines.push(EngineDescriptor {
            name: record.name,
            address: record.address,
            state: status.state,
            resources: record.resources,
            access,
            sessions: status.sessions,
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
