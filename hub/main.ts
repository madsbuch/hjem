import { startHub } from './server';

declare const __HUB_VERSION__: string;

/** As a Home Assistant add-on the Supervisor provides access; elsewhere an address and token are given. */
const supervisorToken = process.env.SUPERVISOR_TOKEN;
const haUrl = process.env.HJEM_HA_URL || (supervisorToken ? 'http://supervisor/core' : '');
const haToken = process.env.HJEM_HA_TOKEN || supervisorToken || '';
if (!haUrl || !haToken) {
  console.error('Hjem hub needs Home Assistant. Run it as a Home Assistant add-on, or set HJEM_HA_URL and HJEM_HA_TOKEN.');
  process.exit(1);
}
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const hub = await startHub({
  haUrl: haUrl.replace(/\/+$/, ''),
  haToken,
  dataDir: process.env.HJEM_DATA || '/data',
  port: Number(process.env.PORT) || 8099,
  version: __HUB_VERSION__,
  log,
});
const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
for (const signal of signals) process.on(signal, () => void hub.close().finally(() => process.exit(0)));
