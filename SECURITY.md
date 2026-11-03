# Security Policy

## Supported Versions

| Version | Supported | Security Maintenance |
| :--- | :--- | :--- |
| 1.0.x | Yes | Active maintenance |
| < 1.0.0 | No | Deprecated |

---

## Vulnerability Disclosure Protocol

If you identify a security issue, unsafe DOM injection, or privilege escalation defect in these userscripts, please report it via private email:

* **Security Contact**: goharrehmanfsd260@gmail.com
* **Repository Maintainer**: Gohar Rehman (@itsgoharrehman)
* **Response SLA**: Acknowledgment within 48 hours; resolution plan within 5 business days.

---

## Userscript Security Invariants

1. **Zero External Requests**: Scripts must not make unauthorized outbound network calls (`GM_xmlhttpRequest` or `fetch`) to third-party servers. All data processing occurs locally within the browser session.
2. **Credential Safety**: Scripts are strictly restricted from inspecting session cookies, authorization headers, or user password fields.
3. **Safe DOM Injection**: All UI elements (overlays, speed controls) must be created using safe DOM APIs without unsanitized string evaluation (`eval` or raw `innerHTML`).
