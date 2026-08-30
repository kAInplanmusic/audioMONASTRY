import 'dotenv/config';
import { cloudHealth, syncCloudDatabase } from '../server/cloud';

(async () => {
  const health = await cloudHealth();
  console.log('HEALTH', JSON.stringify(health));
  const sync = await syncCloudDatabase();
  console.log('SYNC', JSON.stringify(sync));
})();
