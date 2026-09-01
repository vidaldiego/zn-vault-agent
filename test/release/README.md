# Release tarball compatibility smoke

This gate tests the exact npm tarballs that will be published. It does not read
either repository at runtime and it never connects to ZnVault or a real Payara
host.

The runner creates disposable, read-only Linux containers for the Node.js
22.13 release floor and Node.js 24. In each container it:

1. installs both local tarballs together without lifecycle scripts or a lockfile;
2. checks exact package versions, engine metadata, the Payara peer range, public
   exports, private export boundaries, the agent CLI version, and proves both
   `--env-secret` and `-e` reach the packaged CLI parser under each Node runtime;
3. loads Payara 3.0.0 through the packaged Agent 2.0.0 `PluginLoader`;
4. initializes and starts the real plugin against a local `asadmin`, HTTP health
   endpoint, and one fake DAS process with an exact Linux procfs identity;
5. creates a private 43-character control token, starts the packaged Agent HTTP
   server, verifies the public health probe, an unauthenticated plugin 401, and
   an authenticated request crossing both Agent and Payara route guards;
6. verifies healthy epoch-bound startup, shared-lock release, clean shutdown,
   and prints SHA-256 receipts for both input tarballs without printing the
   credential.

Run it with absolute or relative tarball paths:

```bash
./test/release/tarball-smoke.sh \
  /path/to/zincapp-zn-vault-agent-2.0.0.tgz \
  /path/to/zincapp-znvault-plugin-payara-3.0.0.tgz
```

To pin the container inputs by digest, override the default image matrix:

```bash
ZNVAULT_RELEASE_NODE_IMAGES='node@sha256:... node@sha256:...' \
  ./test/release/tarball-smoke.sh agent.tgz plugin.tgz
```
