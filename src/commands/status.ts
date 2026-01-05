import type { Command } from 'commander';
import chalk from 'chalk';
import { isConfigured, loadConfig, getTargets, getConfigPath } from '../lib/config.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show agent configuration and status')
    .option('--json', 'Output as JSON')
    .addHelpText('after', `
Examples:
  zn-vault-agent status         # Human-readable status
  zn-vault-agent status --json  # JSON output for scripting
`)
    .action(async (options) => {
      const config = loadConfig();
      const targets = getTargets();

      if (options.json) {
        console.log(JSON.stringify({
          configured: isConfigured(),
          configPath: getConfigPath(),
          vaultUrl: config.vaultUrl,
          tenantId: config.tenantId,
          authMethod: config.auth.apiKey ? 'apiKey' : (config.auth.username ? 'password' : 'none'),
          insecure: config.insecure,
          pollInterval: config.pollInterval || 3600,
          targets: targets.map(t => ({
            name: t.name,
            certId: t.certId,
            outputs: t.outputs,
            lastSync: t.lastSync,
            lastFingerprint: t.lastFingerprint,
          })),
        }, null, 2));
        return;
      }

      console.log();
      console.log(chalk.bold('ZN-Vault Agent Status'));
      console.log();

      if (!isConfigured()) {
        console.log(chalk.yellow('  Status: Not configured'));
        console.log();
        console.log('Run ' + chalk.cyan('zn-vault-agent login') + ' to configure.');
        return;
      }

      console.log(chalk.green('  Status: Configured'));
      console.log();

      console.log(chalk.bold('Connection'));
      console.log(`  Vault URL:    ${config.vaultUrl}`);
      console.log(`  Tenant ID:    ${config.tenantId}`);
      console.log(`  Auth Method:  ${config.auth.apiKey ? 'API Key' : 'Username/Password'}`);
      console.log(`  TLS Verify:   ${config.insecure ? chalk.yellow('disabled') : chalk.green('enabled')}`);
      console.log(`  Poll Interval: ${config.pollInterval || 3600}s`);
      console.log();

      console.log(chalk.bold('Certificate Targets'));
      if (targets.length === 0) {
        console.log('  No targets configured');
        console.log('  Run ' + chalk.cyan('zn-vault-agent add') + ' to add one.');
      } else {
        for (const target of targets) {
          const syncStatus = target.lastSync
            ? chalk.green(`synced ${new Date(target.lastSync).toLocaleString()}`)
            : chalk.yellow('not synced');

          console.log();
          console.log(`  ${chalk.cyan(target.name)}`);
          console.log(`    Certificate: ${target.certId.substring(0, 8)}...`);
          console.log(`    Status:      ${syncStatus}`);
          console.log(`    Outputs:`);
          for (const [type, path] of Object.entries(target.outputs)) {
            if (path) console.log(`      ${type}: ${path}`);
          }
          if (target.reloadCmd) {
            console.log(`    Reload:      ${target.reloadCmd}`);
          }
          if (target.healthCheckCmd) {
            console.log(`    Health:      ${target.healthCheckCmd}`);
          }
        }
      }

      console.log();
      console.log(chalk.gray(`Config: ${getConfigPath()}`));
      console.log();
    });
}
