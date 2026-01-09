# Changelog

All notable changes to ZN-Vault Agent will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.13.0] - 2026-01-09 - Degraded State Recovery

### Added
- **DegradedModeHandler Service**
  - New `src/services/degraded-mode-handler.ts` for handling degraded connection states
  - Automatic detection when agent enters degraded mode (expired/revoked keys)
  - Callback system for credential updates and state changes
  - Reprovision token claim functionality

- **WebSocket Degraded Connection Support**
  - Handler for `degraded_connection` messages from server
  - Handler for `reprovision_available` notifications
  - Automatic state tracking and recovery flow
  - Integration with DegradedModeHandler

- **Types for Degraded Connections**
  - `DegradedReason`: `key_expired`, `key_revoked`, `key_disabled`, `auth_failed`
  - `DegradedConnectionInfo`: Server notification structure
  - `ReprovisionAvailableMessage`: Real-time reprovision notification

### Changed
- **WebSocket Client**
  - Added `onDegradedConnection` callback option
  - Added `onReprovisionAvailable` callback option
  - Daemon mode now initializes DegradedModeHandler

### Technical
- Native HTTP/HTTPS for reprovision token claim (no external dependencies)
- Polling mechanism for reprovision status (30s interval)
- Graceful cleanup on shutdown

---

## [1.12.5] - 2026-01-08

### Fixed
- Minor bug fixes and stability improvements

---

## [1.12.0] - 2026-01-05

### Added
- Initial release with certificate distribution
- WebSocket real-time updates
- Plugin system for application integration
- Payara plugin for Java EE servers
