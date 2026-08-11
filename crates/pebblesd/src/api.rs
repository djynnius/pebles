//! The privileged local API, served on the group-gated unix socket. Reachability of
//! the socket IS the authorization boundary today: only root and the `pebbles` group
//! (the web tier) can connect. Per-caller authorization (admin vs user actions)
//! arrives with the session tokens in Phase 1.

use axum::http::StatusCode;
use axum::{routing::get, routing::post, Json, Router};
use pebbles_api::{
    ApiError, CreateUserRequest, Health, LoginRequest, LoginResponse, Role, UserInfo, VersionInfo,
};
use pebbles_identity::IdentityError;

pub fn router(role: Role) -> Router {
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
        // at registration (Phase 1), they never create them.
        Role::Main => base
            .route("/users", get(list_users).post(create_user))
            .route("/auth/login", post(login)),
        Role::Engine => base,
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

async fn create_user(Json(req): Json<CreateUserRequest>) -> ApiResult<UserInfo> {
    if req.password.len() < 8 {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "password must be at least 8 characters",
        ));
    }
    let result = tokio::task::spawn_blocking(move || {
        pebbles_identity::host::create_user(&req.username, &req.password)
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
