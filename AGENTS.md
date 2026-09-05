# Independent Vault component

This Git root is `~/Drive/vault/zn-vault-agent`. Core, CLI, agent, SDKs and
plugins are sibling repositories with independent dependencies and instructions.
Use this repository's scripts and CI configuration for validation. Refer to
CLAUDE.md when present; old plans may describe the retired nested layout.

Use disposable local test state. Do not copy production credentials, old
node_modules, machine-specific permissions or archived worktree .git pointers.
Legacy sessions and experimental branches remain preserved in Codex-Recovery
and External; historical plans are not deployment authorization.

During recovery, Git hooks and automatic GC remain locally disabled. The old
Mutagen dev-sync stays paused and must not be resumed on these new clones.
The organizational parent has no Git root or inherited core-agent settings.
