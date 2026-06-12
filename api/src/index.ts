import 'dotenv/config';
import { createApp } from './app';
import { startGmailPoller } from './jobs/gmailPoller';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const app = createApp();

app.listen(PORT, () => {
  console.log(`[server] running on port ${PORT} (v${process.env.npm_package_version ?? '1.0.0'})`);
  startGmailPoller();
});
