# LLM Response Fixtures

Filename pattern: `<scenario>__<step>.json`

Each file:

    {
      "system": "<system prompt prefix the test expects>",
      "user": "<user message verbatim>",
      "response": "<canned Gemini reply>",
      "maxTokens": 500
    }

If a test invokes `callGemini` with a (system, user) pair that has no fixture, the mock throws — this surfaces test/fixture drift immediately.
