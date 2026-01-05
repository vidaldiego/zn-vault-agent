import { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { isConfigured, getTargets } from '../lib/config.js';
import { deployCertificate, deployAllCertificates } from '../lib/deployer.js';

export function registerSyncCommand(program: Command): void {
  program
    .command('sync')
    .description('Sync certificates to configured targets')
    .option('-f, --force', 'Force sync even if certificate unchanged')
    .option('-t, --target <name>', 'Sync specific target only')
    .option('--dry-run', 'Show what would be done without making changes')
    .addHelpText('after', `
Examples:
  # Sync all configured certificates
  zn-vault-agent sync

  # Force sync (even if unchanged)
  zn-vault-agent sync --force

  # Sync only a specific target
  zn-vault-agent sync --target haproxy-frontend

  # Preview what would be synced
  zn-vault-agent sync --dry-run
`)
    .action(async (options) => {
      if (!isConfigured()) {
        console.error(chalk.red('Not configured. Run: zn-vault-agent login'));
        process.exit(1);
      }

      const targets = getTargets();

      if (targets.length === 0) {
        console.log('No certificate targets configured.');
        console.log('Run ' + chalk.cyan('zn-vault-agent add') + ' to add one.');
        return;
      }

      // Filter to specific target if requested
      const targetsToSync = options.target
        ? targets.filter(t => t.name === options.target || t.certId === options.target)
        : targets;

      if (options.target && targetsToSync.length === 0) {
        console.error(chalk.red(`Target "${options.target}" not found`));
        process.exit(1);
      }

      if (options.dryRun) {
        console.log();
        console.log(chalk.bold('Dry run - would sync:'));
        console.log();
        for (const target of targetsToSync) {
          console.log(`  ${chalk.cyan(target.name)}`);
          console.log(`    Certificate: ${target.certId.substring(0, 8)}...`);
          console.log(`    Outputs:`);
          for (const [type, path] of Object.entries(target.outputs)) {
            if (path) console.log(`      ${type}: ${path}`);
          }
          if (target.reloadCmd) {
            console.log(`    Reload: ${target.reloadCmd}`);
          }
          console.log();
        }
        return;
      }

      console.log();
      console.log(chalk.bold('Syncing Certificates'));
      console.log();

      let successCount = 0;
      let failCount = 0;
      let unchangedCount = 0;

      for (const target of targetsToSync) {
        const spinner = ora(`Syncing ${target.name}...`).start();

        try {
          const result = await deployCertificate(target, options.force);

          if (result.success) {
            if (result.message === 'Certificate unchanged') {
              spinner.info(`${target.name}: unchanged`);
              unchangedCount++;
            } else {
              spinner.succeed(`${target.name}: ${result.message}`);
              successCount++;

              // Show details
              if (result.filesWritten && result.filesWritten.length > 0) {
                for (const file of result.filesWritten) {
                  console.log(`    ${chalk.gray('→')} ${file}`);
                }
              }
              if (result.reloadOutput) {
                console.log(`    ${chalk.gray('reload:')} ${result.reloadOutput.trim()}`);
              }
              if (result.healthCheckPassed !== undefined) {
                const status = result.healthCheckPassed
                  ? chalk.green('passed')
                  : chalk.red('failed');
                console.log(`    ${chalk.gray('health:')} ${status}`);
              }
            }
          } else {
            spinner.fail(`${target.name}: ${result.message}`);
            failCount++;

            if (result.rolledBack) {
              console.log(`    ${chalk.yellow('→ Rolled back to previous certificate')}`);
            }
          }
        } catch (err) {
          spinner.fail(`${target.name}: ${err instanceof Error ? err.message : String(err)}`);
          failCount++;
        }
      }

      console.log();
      console.log(chalk.bold('Summary:'));
      if (successCount > 0) console.log(`  ${chalk.green('✓')} ${successCount} updated`);
      if (unchangedCount > 0) console.log(`  ${chalk.gray('○')} ${unchangedCount} unchanged`);
      if (failCount > 0) console.log(`  ${chalk.red('✗')} ${failCount} failed`);
      console.log();

      if (failCount > 0) {
        process.exit(1);
      }
    });
}
