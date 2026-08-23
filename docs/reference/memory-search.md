# Memory Search

Semantic search across session summaries using embedding-based similarity.

## Overview

Memory search enables agents to find relevant past conversations based on semantic meaning rather than keyword matching. When transcripts are summarized during compaction, embeddings (vector representations) are generated and stored alongside the summary. The `memory_search` tool uses these embeddings to find conceptually similar sessions.

## Configuration

Enable memory search embeddings in your OpenClaw config:

```json
{
  "memory": {
    "search": {
      "enabled": true,
      "provider": "openai",
      "model": "text-embedding-3-small"
    }
  }
}
```

**Options:**

- `enabled`: Enable/disable memory search embeddings (default: `false`)
- `provider`: Embedding provider id (for example `"openai"`)
- `model`: Embedding model to use (default: `"text-embedding-3-small"`)

## Memory Search Tool

Agents can use the `memory_search` tool to search across session summaries:

```typescript
{
  "name": "memory_search",
  "description": "Search across session summaries using semantic similarity",
  "parameters": {
    "query": "What decisions did we make about authentication?",
    "topK": 5,
    "minScore": 0.3
  }
}
```

**Parameters:**

- `query` (required): Search query for semantic similarity search
- `topK` (optional): Number of results to return, default: 5, max: 20
- `minScore` (optional): Minimum similarity score (0-1), default: 0.3

## How It Works

1. **Embedding Generation**: During transcript compaction, a combined text is created from the summary, decisions, action items, risks, topics, and people. This text is passed to the configured embedding provider to generate a vector representation.

2. **Storage**: The embedding vector is stored in `summary.json` alongside other summary metadata.

3. **Search**: When `memory_search` is called:
   - The query is converted to an embedding using the same provider
   - Cosine similarity is computed between the query embedding and all stored summary embeddings
   - Results are filtered by `minScore` and sorted by similarity score
   - Top `topK` results are returned

## Example Output

```
Found 3 relevant summaries for: "authentication decisions"

## Authentication Discussion (transcript-2024-01-15-abc123)
Similarity: 85.2%

We discussed JWT authentication and decided to use it for API requests.

Decisions:
- Use JWT for authentication
- Set token expiry to 1 hour
- Store tokens in httpOnly cookies

Action Items:
- Implement JWT middleware
- Add token refresh logic
```

## Embedding Providers

Memory search uses the Memory Embedding Provider infrastructure. By default, it uses the `openai` provider with `text-embedding-3-small`. To configure a different provider, ensure it's registered and available in the embedding provider runtime.

## Cosine Similarity

The similarity metric is cosine similarity, which measures the angle between two vectors:

- `1.0`: Identical direction (perfect match)
- `0.0`: Orthogonal (no relationship)
- `-1.0`: Opposite direction

For normalized embedding vectors, this is effectively the dot product.

## Performance Considerations

- Embedding generation adds latency to compaction (~100-500ms depending on provider)
- Search scales linearly with number of stored summaries (O(n) similarity computations)
- For hundreds of sessions, search remains fast (<100ms)
- For thousands of sessions, consider indexing strategies

## See Also

- [Transcripts](/cli/transcripts) - Transcript capture and storage
- [Compaction](/compaction) - Session compaction process
- [Embedding](/gateway/embedding) - Configuring embedding providers
