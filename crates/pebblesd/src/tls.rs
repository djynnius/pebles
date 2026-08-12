//! Cluster-API TLS (NFR-02). Each container self-signs a certificate at first
//! boot (persisted in the config volume) and serves its cluster port over TLS.
//! Peers authenticate certificates by SHA-256 **fingerprint pinning** with
//! trust-on-first-use: the first connection to a peer learns its fingerprint,
//! every later connection requires an exact match — the ssh model. Bearer
//! secrets keep doing authentication; TLS adds confidentiality and, once
//! pinned, server authenticity. There is no CA and deliberately so: nothing
//! here should ever depend on the public PKI (NFR-03).

use std::path::{Path, PathBuf};
use std::sync::Arc;

fn tls_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("cluster")
}

/// Load-or-create this container's cluster certificate. Sticky in the config
/// volume: upgrades keep the identity, so peers' pins stay valid (REQ-09).
pub fn ensure_cert(config_dir: &Path) -> anyhow::Result<(Vec<u8>, Vec<u8>)> {
    use std::os::unix::fs::PermissionsExt;
    let dir = tls_dir(config_dir);
    std::fs::create_dir_all(&dir)?;
    let cert_path = dir.join("tls-cert.pem");
    let key_path = dir.join("tls-key.pem");
    if cert_path.exists() && key_path.exists() {
        return Ok((std::fs::read(&cert_path)?, std::fs::read(&key_path)?));
    }
    // Hostnames and IPs drift (DHCP); identity comes from the pin, not the SAN.
    let mut params = rcgen::CertificateParams::new(vec!["pebbles".to_string()])?;
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "pebbles-cluster");
    let key_pair = rcgen::KeyPair::generate()?;
    let cert = params.self_signed(&key_pair)?;
    let cert_pem = cert.pem().into_bytes();
    let key_pem = key_pair.serialize_pem().into_bytes();
    std::fs::write(&cert_path, &cert_pem)?;
    std::fs::write(&key_path, &key_pem)?;
    std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600))?;
    tracing::info!(cert = %cert_path.display(), "cluster TLS certificate created");
    Ok((cert_pem, key_pem))
}

/// SHA-256 fingerprint (lowercase hex) of the first certificate in a PEM.
pub fn fingerprint_pem(cert_pem: &[u8]) -> Option<String> {
    let der = rustls_pemfile::certs(&mut &cert_pem[..]).next()?.ok()?;
    Some(fingerprint_der(der.as_ref()))
}

pub fn fingerprint_der(cert_der: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(cert_der))
}

/// The axum-server rustls config for this container's cluster port.
pub async fn server_config(
    cert_pem: Vec<u8>,
    key_pem: Vec<u8>,
) -> anyhow::Result<axum_server::tls_rustls::RustlsConfig> {
    axum_server::tls_rustls::RustlsConfig::from_pem(cert_pem, key_pem)
        .await
        .map_err(|e| anyhow::anyhow!("cluster TLS config: {e}"))
}

/// Certificate verifier that pins by fingerprint. `expected: None` = trust on
/// first use (accept and let the caller learn the fingerprint); `Some(fp)` =
/// require that exact certificate, refuse anything else.
#[derive(Debug)]
pub struct PinnedVerifier {
    expected: Option<String>,
    provider: rustls::crypto::CryptoProvider,
}

impl PinnedVerifier {
    pub fn new(expected: Option<String>) -> Self {
        Self {
            expected,
            provider: rustls::crypto::ring::default_provider(),
        }
    }
}

impl rustls::client::danger::ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        match &self.expected {
            None => Ok(rustls::client::danger::ServerCertVerified::assertion()),
            Some(want) => {
                let got = fingerprint_der(end_entity.as_ref());
                if &got == want {
                    Ok(rustls::client::danger::ServerCertVerified::assertion())
                } else {
                    Err(rustls::Error::General(format!(
                        "peer certificate fingerprint mismatch (pinned {}…, got {}…)",
                        &want[..12.min(want.len())],
                        &got[..12]
                    )))
                }
            }
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// An HTTPS client that pins the peer's certificate (or learns it, TOFU).
pub fn pinned_client(expected_fp: Option<String>) -> reqwest::Client {
    let config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedVerifier::new(expected_fp)))
        .with_no_client_auth();
    reqwest::Client::builder()
        .use_preconfigured_tls(config)
        .build()
        .expect("reqwest client")
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::client::danger::ServerCertVerifier;

    fn test_cert() -> (Vec<u8>, String) {
        let params = rcgen::CertificateParams::new(vec!["pebbles".to_string()]).unwrap();
        let key = rcgen::KeyPair::generate().unwrap();
        let cert = params.self_signed(&key).unwrap();
        let der = cert.der().to_vec();
        let fp = fingerprint_der(&der);
        (der, fp)
    }

    #[test]
    fn certs_persist_and_fingerprint_is_stable() {
        let dir = tempfile::tempdir().unwrap();
        let (cert1, key1) = ensure_cert(dir.path()).unwrap();
        let (cert2, key2) = ensure_cert(dir.path()).unwrap();
        assert_eq!(cert1, cert2, "certificate identity is sticky (REQ-09)");
        assert_eq!(key1, key2);
        let fp = fingerprint_pem(&cert1).expect("pem parses");
        assert_eq!(fp.len(), 64);
        assert_eq!(fp, fingerprint_pem(&cert2).unwrap());
    }

    #[test]
    fn pinned_verifier_enforces_the_exact_fingerprint() {
        let (der_a, fp_a) = test_cert();
        let (der_b, _) = test_cert();
        let name = rustls::pki_types::ServerName::try_from("pebbles").unwrap();
        let now = rustls::pki_types::UnixTime::now();

        let tofu = PinnedVerifier::new(None);
        assert!(tofu
            .verify_server_cert(&der_a.clone().into(), &[], &name, &[], now)
            .is_ok());

        let pinned = PinnedVerifier::new(Some(fp_a));
        assert!(pinned
            .verify_server_cert(&der_a.into(), &[], &name, &[], now)
            .is_ok());
        assert!(pinned
            .verify_server_cert(&der_b.into(), &[], &name, &[], now)
            .is_err());
    }
}
