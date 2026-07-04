# L2 Eviction Policy Audit — 2026-07-04

## Summary
This audit confirms that OpenClaw's current eviction policies align with SOLAR research findings (arXiv:2607.00394) and recommends a Bayesian approach for future ANN milestone implementation.

## Current State Analysis

### L1 Sliding Window (`extensions/memory-l3/src/sliding-window.ts`)
- **Policy**: Token-budget contiguous tail (FIFO-like)
- **Assessment**: ✅ **GOOD** - Aligns with SOLAR findings
- **Rationale**: Most recent message always included; oldest messages drop when budget exceeded
- **SOLAR Alignment**: FIFO outperforms LRU on semantic workloads due to lack of temporal locality

### L2 Compaction (`extensions/memory-l3/src/compaction.ts`)
- **Policy**: Epoch-based consolidation, no per-chunk eviction
- **Assessment**: ✅ **APPROPRIATE** - Different design than cache eviction
- **Rationale**: All chunks within an epoch compacted together; manages consolidation, not cache pressure
- **SOLAR Relevance**: Not directly applicable (different use case)

### L3 Epoch Management (`extensions/memory-l3/src/epoch.ts`)
- **Policy**: Trigger-based at `EPOCH_CHUNK_THRESHOLD` boundaries
- **Assessment**: ✅ **GOOD** - Avoids per-chunk eviction entirely
- **Rationale**: Algorithmic importance-based selection, no temporal eviction

## Future Recommendations

### ANN Milestone (when ~10k chunks reached)
- **Approach**: Implement SOLAR Bayesian eviction policy for retrieval buffer management
- **Trigger**: When sqlite-vec ANN migration occurs and cache hit rates become measurable
- **Expected Improvement**: 5-75% improvement at tight cache sizes per SOLAR paper
- **Implementation**: Will replace any LRU-like policy in future retrieval buffer design

## Risk Assessment
- **Current Risk**: **LOW** - Existing policies are appropriate for their respective tiers
- **Future Risk**: **MEDIUM** - ANN milestone will require careful integration with existing retrieval pipeline
- **Mitigation**: A/B testing using existing `segmentedCompaction` flag pattern for controlled rollout

## Files Modified
- `extensions/memory-l3/src/sliding-window.ts` - Added FIFO alignment documentation
- `extensions/memory-l3/src/compaction.ts` - Added epoch-based consolidation documentation  
- `extensions/memory-l3/src/epoch.ts` - Added consolidation-focused policy documentation

## Conclusion
Current eviction policies are sound and align with research findings. No immediate changes needed. SOLAR Bayesian approach recommended for future ANN milestone implementation.