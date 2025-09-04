
// This file is specifically for testing environment variable checks at module load time.

// Mock dotenv/config to prevent it from loading actual .env variables
jest.mock('dotenv/config', () => ({}));

describe('Environment Variable Checks', () => {
    const originalSecret = process.env.LINE_CHANNEL_SECRET;
    const originalToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;

    beforeEach(() => {
        jest.resetModules(); // Reset modules before each test
        // Ensure env vars are undefined for the test
        delete process.env.LINE_CHANNEL_SECRET;
        delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    });

    afterEach(() => {
        // Restore original env vars after each test
        process.env.LINE_CHANNEL_SECRET = originalSecret;
        process.env.LINE_CHANNEL_ACCESS_TOKEN = originalToken;
    });

    it('should throw error if LINE env vars are missing', () => {
        let error: Error | undefined;
        try {
            // Use isolateModules to ensure a fresh import
            jest.isolateModules(() => {
                require('./index');
            });
        } catch (e: any) {
            error = e;
        }
        expect(error).toBeInstanceOf(Error);
        expect(error?.message).toBe('Missing LINE channel secret or access token');
    });
});
