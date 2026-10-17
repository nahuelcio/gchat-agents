use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;

const CHAT_SYSTEM_ACCOUNT: &str = "chat@system.gserviceaccount.com";
const JWKS_URL: &str = "https://www.googleapis.com/oauth2/v3/certs";

#[async_trait]
pub trait TokenVerifier: Send + Sync {
    async fn verify(&self, auth_header: Option<&str>) -> Result<(), String>;
}

pub struct AcceptAllVerifier;

#[async_trait]
impl TokenVerifier for AcceptAllVerifier {
    async fn verify(&self, _auth_header: Option<&str>) -> Result<(), String> {
        Ok(())
    }
}

pub fn audience_mode(audience: &str) -> &'static str {
    if audience.starts_with("https://") {
        "url"
    } else {
        "project"
    }
}

pub fn extract_bearer(auth_header: Option<&str>) -> Result<String, String> {
    let header = auth_header.ok_or_else(|| "missing bearer token".to_string())?;
    static RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)^Bearer\s+(\S+)$").unwrap());
    RE.captures(header)
        .map(|c| c[1].to_string())
        .ok_or_else(|| "missing bearer token".to_string())
}

#[derive(Debug, Deserialize)]
struct ChatClaims {
    email: Option<String>,
    iss: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}

#[derive(Debug, Clone, Deserialize)]
struct Jwk {
    kid: Option<String>,
    n: Option<String>,
    e: Option<String>,
}

#[async_trait]
pub trait CertSource: Send + Sync {
    async fn key_for_kid(&self, kid: &str) -> Result<DecodingKey, String>;
}

pub struct GoogleJwksSource {
    client: reqwest::Client,
    cache: Mutex<Option<(Instant, HashMap<String, Jwk>)>>,
}

impl GoogleJwksSource {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
            cache: Mutex::new(None),
        }
    }

    async fn load(&self) -> Result<HashMap<String, Jwk>, String> {
        {
            let guard = self.cache.lock().unwrap();
            if let Some((at, map)) = guard.as_ref() {
                if at.elapsed() < Duration::from_secs(3600) {
                    return Ok(map.clone());
                }
            }
        }
        let body: Jwks = self
            .client
            .get(JWKS_URL)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        let mut map = HashMap::new();
        for k in body.keys {
            if let Some(kid) = k.kid.clone() {
                map.insert(kid, k);
            }
        }
        *self.cache.lock().unwrap() = Some((Instant::now(), map.clone()));
        Ok(map)
    }
}

impl Default for GoogleJwksSource {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl CertSource for GoogleJwksSource {
    async fn key_for_kid(&self, kid: &str) -> Result<DecodingKey, String> {
        let map = self.load().await?;
        let jwk = map.get(kid).ok_or_else(|| format!("unknown kid {kid}"))?;
        let n = jwk.n.as_deref().ok_or_else(|| "jwk missing n".to_string())?;
        let e = jwk.e.as_deref().ok_or_else(|| "jwk missing e".to_string())?;
        DecodingKey::from_rsa_components(n, e).map_err(|e| e.to_string())
    }
}

pub struct GoogleTokenVerifier {
    pub audience: String,
    pub certs: std::sync::Arc<dyn CertSource>,
}

impl GoogleTokenVerifier {
    pub fn new(audience: String) -> Self {
        Self {
            audience,
            certs: std::sync::Arc::new(GoogleJwksSource::new()),
        }
    }
}

#[async_trait]
impl TokenVerifier for GoogleTokenVerifier {
    async fn verify(&self, auth_header: Option<&str>) -> Result<(), String> {
        let token = extract_bearer(auth_header)?;
        let header = decode_header(&token).map_err(|e| e.to_string())?;
        let kid = header.kid.ok_or_else(|| "token missing kid".to_string())?;
        let key = self.certs.key_for_kid(&kid).await?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.validate_exp = true;
        validation.set_audience(std::slice::from_ref(&self.audience));
        let data = decode::<ChatClaims>(&token, &key, &validation).map_err(|e| e.to_string())?;
        let claims = data.claims;
        if audience_mode(&self.audience) == "url" {
            if claims.email.as_deref() != Some(CHAT_SYSTEM_ACCOUNT) {
                return Err("token not issued by Google Chat".into());
            }
        } else {
            if claims.iss.as_deref() != Some(CHAT_SYSTEM_ACCOUNT) {
                return Err("token not issued by Google Chat".into());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{encode, EncodingKey, Header};
    use serde::Serialize;
    use std::sync::Arc;

    #[test]
    fn audience_modes() {
        assert_eq!(audience_mode("https://x.example/google/chat"), "url");
        assert_eq!(audience_mode("1234567890"), "project");
    }

    #[tokio::test]
    async fn missing_bearer_rejected() {
        let v = GoogleTokenVerifier {
            audience: "https://example.com/google/chat".into(),
            certs: Arc::new(FixedPem(TEST_PUB.into())),
        };
        assert!(v.verify(None).await.is_err());
    }

    #[derive(Serialize)]
    struct TestClaims {
        aud: String,
        email: String,
        exp: i64,
        iat: i64,
    }

    struct FixedPem(String);

    #[async_trait]
    impl CertSource for FixedPem {
        async fn key_for_kid(&self, _kid: &str) -> Result<DecodingKey, String> {
            DecodingKey::from_rsa_pem(self.0.as_bytes()).map_err(|e| e.to_string())
        }
    }

    #[tokio::test]
    async fn verifies_signed_token() {
        let rsa = EncodingKey::from_rsa_pem(TEST_PRIV.as_bytes()).unwrap();
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some("test".into());
        let now = chrono::Utc::now().timestamp();
        let token = encode(
            &header,
            &TestClaims {
                aud: "https://example.com/google/chat".into(),
                email: CHAT_SYSTEM_ACCOUNT.into(),
                exp: now + 3600,
                iat: now,
            },
            &rsa,
        )
        .unwrap();
        let v = GoogleTokenVerifier {
            audience: "https://example.com/google/chat".into(),
            certs: Arc::new(FixedPem(TEST_PUB.into())),
        };
        v.verify(Some(&format!("Bearer {token}"))).await.unwrap();
        assert!(v.verify(Some("Bearer not-a-jwt")).await.is_err());
    }

    const TEST_PRIV: &str = "-----BEGIN RSA PRIVATE KEY-----
MIIEogIBAAKCAQEAndFPS8U4n2hdvvmGhw32XiRXtbPs+DkUYKBShXRmi1a6ETpn
mWmG4IvnoJN7uQUZPCTAVmem3gzB7EvUk/RCC3hYNJGW2HFZiglNJhuMfX+26Ga3
zviNkYOeBFn6aGSWxs6PI8q/StdxRd6Ca25hjgWo8WJB8UTVwyxUDX/9n6nSt+K0
Ea45sRxRlpfpxDBeA+mDivYtu5ksGQAf1tTlHVaNRqhvftZrWLCCm/tiZJ6uRHfF
izp2O4RKnoJ3JpNRCJ47/qDjw45Nd3Pzk0kNdQEghhTEZJqNrEZNXgwM2XKEnSfO
uyrBDxzR+zt3BaBTl5ho3E5NpyEh1BpE/Faa2QIDAQABAoIBAEzPZ7GwHpvvNtlR
JvmqgQNW2t2T4bz6QwG4ZhGQEqy0nEDwVSXkp4G4dhbAUVI+ugZ8uKQVNLEUMnoo
eiE8m7xraTrEtU9I89RsLIFknR8jvskj3Ug9zuFI1uq1RFv0wTGnrSE1d58cdoQU
BRP2mEKAXLaHJSMhZozkkVA0wCMpxwuy1V9+SFKjMtBqoV5H8CjoBMRu0312iZPV
cOK01R/SwetTtJu2d7eccVrECPSUH9BfpCH7K74u8sxL+RcJiO8V3zrknZyYBT0X
r9e1V3QRoiN5GZsglmVqB+1heOSLoNcRsSVFeNSOdBGRusQiTjnNp2misiexbqgT
G7375ZUCgYEA2q4F8K3y/HWQ1wpRpZuiX054MJtiD4C5giKkY3StTnY64cwSWivu
Ny5vK+PvpE+fB5gGW1VyL44XKGxOReQPfd8a7+iTKoENWTqh38EC/5O1ufghZhb/
w7DAJGNXF5+p0Zq8nde3VTD0PD2jAaU66lpO5o/Ffulu6FaAw3NRJl8CgYEAuMBC
JywRJjDqGYK8ePHtqtkbqKoHrLXUSG/9XMMwcT01SlVfnMvrgchCLoYdMWJd9aC0
opxTcj0jrFveKRC71FAaRtK1x9MyRzUuPRQ6fNmWyypdPItvId2JP03LjGZxjTnr
zaARrIYQkQ2npAQIxidSR4wrnQB1WIfNZwqNmccCgYAFudDGAIgAPEPSnZ6Nq4mQ
3UkgXLEwnro8whNz1zZCe64HA4Tnf4b5Qun+SDWaI8uSM1TXR2F6BUpt8IgMJHCT
ZygZaAmSb1aeI37hkPg3IPL9L5YQSkHgKdyeF0vMfo2/w0F1EJToUiPS//oorN7i
DANM3i7Zp9sTklBEzdwuGQKBgDa/mpr7HxXfNvBaYrnAj7qqXdzsjhurQn442a8M
lKVqCwm9JPlVILQ0ARDCY5JH4Sox9nWdt8jJv3GLQ9mNgOvY1QCZ3o6Z0nNxmgM1
pGNtI5ePNVQEyekSOmLNDf3MOegs+ujTf4lNrUke78fV/jeiXWqgaig7g4q5q6/W
W8HvAoGAHb2IyhklNX91RLJEqxlhsPAdF08RNfSR3HhfHGF61YyGMeqbrEPA7wwM
GtxxmbVoyizNptHhPrudf0XotySbWPWH6fr9EmYwXfwZL1oe0xe8U1ZAQED1P9Wi
Mm34nQQ5i+3YD/iKmsV0Ll4gnNZ8REM+m40d/naX90of8xYGS8I=
-----END RSA PRIVATE KEY-----";

    const TEST_PUB: &str = "-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAndFPS8U4n2hdvvmGhw32
XiRXtbPs+DkUYKBShXRmi1a6ETpnmWmG4IvnoJN7uQUZPCTAVmem3gzB7EvUk/RC
C3hYNJGW2HFZiglNJhuMfX+26Ga3zviNkYOeBFn6aGSWxs6PI8q/StdxRd6Ca25h
jgWo8WJB8UTVwyxUDX/9n6nSt+K0Ea45sRxRlpfpxDBeA+mDivYtu5ksGQAf1tTl
HVaNRqhvftZrWLCCm/tiZJ6uRHfFizp2O4RKnoJ3JpNRCJ47/qDjw45Nd3Pzk0kN
dQEghhTEZJqNrEZNXgwM2XKEnSfOuyrBDxzR+zt3BaBTl5ho3E5NpyEh1BpE/Faa
2QIDAQAB
-----END PUBLIC KEY-----";
}
