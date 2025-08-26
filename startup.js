import { handler } from './index.js';

async function startup() {
    try {
        if (!process.env.EVENT) {
            throw new Error('EVENT environment variable is required');
        }

        if (!process.env.MY_S3_BUCKET) {
            throw new Error('MY_S3_BUCKET environment variable is required');
        }

        if (!process.env.MY_AWS_REGION) {
            throw new Error('MY_AWS_REGION environment variable is required');
        }

        console.log('Starting video processor...');
        const event = JSON.parse(process.env.EVENT);

        const result = await handler(event);

        console.log('Processing result:', result);

        if (result.statusCode === 200) {
            process.exit(0);
        } else {
            process.exit(1);
        }
    } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    }
}

startup();
