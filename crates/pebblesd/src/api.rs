//! The privileged local API, served on the group-gated unix socket. Reachability of
//! the socket IS the authorization boundary today: only root and the `pebbles` group
//! (the web tier) can connect. Per-caller authorization (admin vs user actions)
//! arrives with the session tokens in Phase 1.

use crate::catalog::{self, CatalogError, CatalogInfo};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use pebbles_api::{
    ApiError, CatalogDescriptor, CreateCatalogRequest, CreateUserRequest, Health, LoginRequest,
    LoginResponse, OpenSessionRequest, Role, SessionDescriptor, UserInfo, VersionInfo,
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
}

pub fn router(role: Role, state: AppState) -> Router {
    let base = Router::new()
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
        );
    match role {
        // Identity lives on the main (REQ-11); engines receive replicated accounts
        // at registration (Phase 1), they never create them. Sessions are served by
        // the main too while it doubles as the single-box engine (REQ-04).
        Role::Main => base
            .route("/users", get(list_users).post(create_user))
            .route("/auth/login", post(login))
            .route("/sessions", get(list_sessions).post(open_session))
            .route("/sessions/{id}", delete(close_session))
            .route("/sessions/{id}/exec", post(exec_session))
            .route("/catalogs", get(list_catalogs).post(create_catalog)),
        Role::Engine => base,
    }
    .with_state(state)
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

async fn exec_session(
    State(state): State<AppState>,
    Path(id): Path<u64>,
    Json(payload): Json<Value>,
) -> ApiResult<Value> {
    let broker = broker_of(&state)?;
    Ok(Json(broker.exec(id, payload).await.map_err(session_error)?))
}

async fn close_session(State(state): State<AppState>, Path(id): Path<u64>) -> ApiResult<Value> {
    let broker = broker_of(&state)?;
    broker.close(id).await.map_err(session_error)?;
    Ok(Json(serde_json::json!({ "closed": id })))
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
