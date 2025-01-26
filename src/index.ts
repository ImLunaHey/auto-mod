import { Jetstream } from '@skyware/jetstream';
import { LabelerServer } from '@skyware/labeler';
import 'dotenv/config';
import fs from 'node:fs';
import { pino } from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
});

const DID = process.env.DID ?? '';
const SIGNING_KEY = process.env.SIGNING_KEY ?? '';
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = process.env.PORT ? Number(process.env.PORT) : 4100;
const FIREHOSE_URL = process.env.FIREHOSE_URL ?? 'wss://jetstream.atproto.tools/subscribe';
const CURSOR_UPDATE_INTERVAL = process.env.CURSOR_UPDATE_INTERVAL ? Number(process.env.CURSOR_UPDATE_INTERVAL) : 60000;
const CURSOR_FILE = process.env.CURSOR_FILE ?? 'cursor.txt';
const DB_PATH = process.env.DB_PATH ?? 'labels.db';

const labelerServer = new LabelerServer({ did: DID, signingKey: SIGNING_KEY, dbPath: DB_PATH });

let cursor = 0;
let cursorUpdateInterval: NodeJS.Timeout;

function epochUsToDateTime(cursor: number): string {
  return new Date(cursor / 1000).toISOString();
}

// Load cursor from file or set to current timestamp if missing
try {
  logger.info('Trying to read cursor from cursor.txt...');
  cursor = Number(fs.readFileSync('cursor.txt', 'utf8'));
  logger.info(`Cursor found: ${cursor} (${epochUsToDateTime(cursor)})`);
} catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
    cursor = Math.floor(Date.now() * 1000);
    logger.info(`Cursor not found in cursor.txt, setting cursor to: ${cursor} (${epochUsToDateTime(cursor)})`);
    fs.writeFileSync('cursor.txt', cursor.toString(), 'utf8');
  } else {
    logger.error(error);
    process.exit(1);
  }
}

const jetstream = new Jetstream({
  wantedCollections: ['app.bsky.feed.post'],
  endpoint: FIREHOSE_URL,
  cursor: cursor,
});

jetstream.on('open', () => {
  logger.info(
    `Connected to Jetstream at ${FIREHOSE_URL} with cursor ${jetstream.cursor} (${epochUsToDateTime(jetstream.cursor!)})`,
  );
  cursorUpdateInterval = setInterval(() => {
    if (jetstream.cursor) {
      logger.info(`Cursor updated to: ${jetstream.cursor} (${epochUsToDateTime(jetstream.cursor)})`);
      fs.writeFile('cursor.txt', jetstream.cursor.toString(), (err) => {
        if (err) logger.error(err);
      });
    }
  }, CURSOR_UPDATE_INTERVAL);
});

jetstream.on('close', () => {
  clearInterval(cursorUpdateInterval);
  logger.info('Jetstream connection closed.');
});

jetstream.on('error', (error) => {
  logger.error(`Jetstream error: ${error.message}`);
});

jetstream.onCreate('app.bsky.feed.post', (event) => {
  // only process posts from the test account
  if (event.did !== DID) return;

  const record = event.commit.record;
  if (record.embed?.$type !== 'app.bsky.embed.images') return;

  const images = record.embed.images;
  const hasImagesWithoutAlt = images.some((img) => !img.alt);
  const uri = `at://${event.did}/app.bsky.feed.post/${event.commit.rkey}`;

  // check if the post has media without alt text
  if (!hasImagesWithoutAlt) return;
  console.log(`Post with missing alt text detected: ${uri}`);

  // add label to post
  try {
    labelerServer.createLabel({
      uri,
      val: 'no-alt-text',
    });
    console.log(`Label "no alt text" added to ${uri}`);
  } catch (error: unknown) {
    if (error instanceof Error) console.error(`Failed to label post: ${error.message}`);
    console.error(`Failed to label post: ${error}`);
  }
});

labelerServer.app.listen({ port: PORT, host: HOST }, (error, address) => {
  if (error) {
    logger.error('Error starting server: %s', error);
  } else {
    logger.info(`Labeler server listening on ${address}`);
  }
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  fs.writeFileSync(CURSOR_FILE, jetstream.cursor!.toString(), 'utf8');
  jetstream.close();
  process.exit(0);
});

jetstream.start();
