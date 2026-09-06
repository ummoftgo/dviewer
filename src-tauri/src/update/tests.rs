use super::*;

fn manifest(version: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "version": version,
        "platforms": {
            "windows-x86_64-portable": {
                "url": "https://github.com/ummoftgo/dviewer/releases/download/v0.14.0/app.exe",
                "signature": "test signature, verified before parsing"
            }
        }
    }))
    .unwrap()
}

#[test]
fn manifest_accepts_optional_release_text() {
    let parsed = Manifest::parse(&manifest("0.14.0"), &UrlPolicy::default()).unwrap();
    assert!(parsed.notes.is_none());
    assert!(parsed.pub_date.is_none());
    assert!(parsed
        .asset(Flavor::PortableExe, "windows", "x86_64")
        .is_some());
}

#[test]
fn manifest_requires_version_platforms_and_asset_fields() {
    for text in [
        "{}",
        r#"{"version":"0.14.0"}"#,
        r#"{"version":"0.14.0","platforms":{}}"#,
        r#"{"version":"0.14.0","platforms":{"windows-x86_64-portable":{"url":"https://github.com/ummoftgo/dviewer/releases/x"}}}"#,
    ] {
        assert!(
            Manifest::parse(text.as_bytes(), &UrlPolicy::default()).is_err(),
            "{text}"
        );
    }
}

#[test]
fn manifest_rejects_invalid_semver() {
    for version in ["v0.14.0", "0.14", "0.014.0", "-1.0.0", "0.14.0 "] {
        assert!(
            Manifest::parse(&manifest(version), &UrlPolicy::default()).is_err(),
            "{version}"
        );
    }
}

#[test]
fn manifest_has_a_byte_limit_even_without_http() {
    let mut bytes = manifest("0.14.0");
    bytes.resize(MAX_MANIFEST_BYTES, b' ');
    assert!(Manifest::parse(&bytes, &UrlPolicy::default()).is_ok());
    bytes.push(b' ');
    assert_eq!(
        Manifest::parse(&bytes, &UrlPolicy::default()).unwrap_err(),
        Error::UpdateManifest
    );
}

#[test]
fn manifest_rejects_empty_signature_and_foreign_assets() {
    let original = String::from_utf8(manifest("0.14.0")).unwrap();
    for text in [
        original.replace("test signature, verified before parsing", " "),
        original.replace("github.com", "example.com"),
    ] {
        assert!(Manifest::parse(text.as_bytes(), &UrlPolicy::default()).is_err());
    }
}

#[test]
fn other_platform_is_link_only_and_never_a_windows_fallback() {
    let parsed = Manifest::parse(&manifest("0.14.0"), &UrlPolicy::default()).unwrap();
    assert!(parsed.asset(Flavor::Nsis, "windows", "x86_64").is_none());
    assert!(parsed.asset(Flavor::MacApp, "macos", "aarch64").is_none());
}

#[test]
fn version_comparison_ignores_build_metadata_and_prereleases() {
    let current = Version::parse("0.13.0").unwrap();
    for (version, expected) in [
        ("0.14.0", true),
        ("0.13.0", false),
        ("0.12.9", false),
        ("0.13.0+new", false),
        ("0.14.0-rc.1", false),
        ("0.14.0+build", true),
    ] {
        let parsed = Manifest::parse(&manifest(version), &UrlPolicy::default()).unwrap();
        assert_eq!(
            parsed.is_newer(&current, None, false),
            expected,
            "{version}"
        );
    }
}

#[test]
fn skipped_version_is_hidden_only_from_automatic_checks() {
    let parsed = Manifest::parse(&manifest("0.14.0"), &UrlPolicy::default()).unwrap();
    let current = Version::new(0, 13, 0);
    assert!(!parsed.is_newer(&current, Some("0.14.0"), false));
    assert!(parsed.is_newer(&current, Some("0.14.0"), true));
    assert!(parsed.is_newer(&current, Some("0.13.5"), false));
}

#[test]
fn url_rejects_other_hosts_schemes_ports_and_repository_prefixes() {
    for input in [
        "http://github.com/ummoftgo/dviewer/releases/a",
        "https://example.com/a",
        "https://github.com.evil.test/ummoftgo/dviewer/releases/a",
        "https://github.com:444/ummoftgo/dviewer/releases/a",
        "https://github.com/ummoftgo/dviewer-other/releases/a",
        "https://github.com/ummoftgo/dviewer/releases-evil/a",
        "https://github.com/ummoftgo/dviewer/releases/../../other/a",
        "https://github.com/ummoftgo/dviewer/releases/%2fother/a",
        "https://user@github.com/ummoftgo/dviewer/releases/a",
        "https://github.com/ummoftgo/dviewer/releases/a#fragment",
        "file:///tmp/update.exe",
    ] {
        assert!(
            UrlPolicy::default().validate(input, false).is_err(),
            "{input}"
        );
    }
}

#[test]
fn redirect_allows_only_https_github_assets_cdn() {
    let policy = UrlPolicy::default();
    let cdn = "https://release-assets.githubusercontent.com/a?signature=example";
    assert!(policy.validate(cdn, false).is_err());
    assert!(policy.validate(cdn, true).is_ok());
    assert!(policy
        .validate("https://other.githubusercontent.com/a", true)
        .is_err());
    assert!(policy
        .validate("http://release-assets.githubusercontent.com/a", true)
        .is_err());
    assert!(policy.validate(MANIFEST_URL, false).is_ok());
}

#[test]
fn development_exception_is_exact_loopback_origin() {
    let policy = UrlPolicy::development("http://127.0.0.1:8123/latest.json");
    if !cfg!(debug_assertions) {
        assert!(policy.is_err());
        return;
    }
    let policy = policy.unwrap();
    assert!(policy
        .validate("http://127.0.0.1:8123/app.exe", false)
        .is_ok());
    assert!(policy
        .validate("http://127.0.0.1:8124/app.exe", true)
        .is_err());
    assert!(UrlPolicy::default()
        .validate("http://127.0.0.1:8123/app.exe", false)
        .is_err());
    for input in [
        "http://localhost:8123/latest.json",
        "file:///tmp/latest.json",
        "http://example.com/latest.json",
    ] {
        assert!(UrlPolicy::development(input).is_err());
    }
}

#[test]
fn native_bundle_identity_selects_installed_windows_flavor() {
    let exe = Path::new("/apps/dviewer.exe");
    assert_eq!(
        Flavor::detect("windows", Some(BundleType::Nsis), exe),
        Flavor::Nsis
    );
    assert_eq!(
        Flavor::detect("windows", Some(BundleType::Msi), exe),
        Flavor::Msi
    );
    assert_eq!(Flavor::detect("windows", None, exe), Flavor::PortableExe);
    assert_eq!(
        Flavor::detect("windows", None, Path::new("")),
        Flavor::Unknown
    );
}

#[test]
fn other_bundles_are_recognized_but_have_no_installer() {
    for (os, bundle, path, expected) in [
        (
            "macos",
            Some(BundleType::App),
            "/Apps/dviewer.app/Contents/MacOS/dviewer",
            Flavor::MacApp,
        ),
        (
            "linux",
            Some(BundleType::AppImage),
            "/tmp/mount/dviewer",
            Flavor::AppImage,
        ),
        (
            "linux",
            Some(BundleType::Deb),
            "/usr/bin/dviewer",
            Flavor::Package,
        ),
        (
            "linux",
            Some(BundleType::Rpm),
            "/usr/bin/dviewer",
            Flavor::Package,
        ),
    ] {
        let flavor = Flavor::detect(os, bundle, Path::new(path));
        assert_eq!(flavor, expected);
        assert!(!flavor.can_install(os, "x86_64"));
    }
    assert!(!Flavor::Msi.can_install("windows", "x86_64"));
    assert!(!Flavor::Nsis.can_install("windows", "aarch64"));
    assert!(Flavor::Nsis.can_install("windows", "x86_64"));
    assert!(Flavor::PortableExe.can_install("windows", "x86_64"));
}
