// Loaded first by each test file: fixtures use a few short messages, so close segments after 8 of them (as the fixtures' saved tuning did).
process.env.SUPERLCM_SEGMENT_MESSAGES ||= '8'
