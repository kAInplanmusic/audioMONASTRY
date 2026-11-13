/** Test-only launcher. Never a production cost source. */
import { collectLiveSession } from '../../scripts/audit/live-collector';
if (process.env.NODE_ENV !== 'test') throw new Error('Test fixture requires NODE_ENV=test');
await collectLiveSession({ testSimulation: true });
