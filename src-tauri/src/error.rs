use serde::{Serialize, Serializer};

/// Every error that can reach the frontend. Messages are user-facing Korean —
/// the UI shows them verbatim, so they must explain the problem, not the cause.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("파일을 읽을 수 없습니다: {0}")]
    Io(#[from] std::io::Error),

    #[error("주소를 불러오지 못했습니다: {0}")]
    Fetch(String),

    #[error("문서를 찾을 수 없습니다 (id {0}). 탭이 이미 닫혔을 수 있습니다.")]
    NoSuchDoc(u32),

    #[error("{0}")]
    Rejected(String),

    #[error("JSON 구조를 읽지 못했습니다: {0}")]
    Json(String),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl Error {
    pub fn rejected(msg: impl Into<String>) -> Self {
        Self::Rejected(msg.into())
    }
}
