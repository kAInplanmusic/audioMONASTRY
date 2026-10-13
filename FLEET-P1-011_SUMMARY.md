# FLEET-P1-011: A40-VRAM-Messung - Summary

## What was done
1. Examined the ticket requirements: Measure VRAM usage for each pod (RP1-RP5) on A40 GPUs under:
   - Cold start
   - After warmup  
   - Under load with 4 concurrent users (typical workloads per role)
2. Reviewed project context including:
   - AI_FLEET_STARTPLAN.md (current VRAM estimates and pod configurations)
   - model_manifest.json (individual model VRAM estimates)
   - deploy/runpod/pod-fleet.json (current deployments and target configurations)
3. Created a VRAM measurement script (`scripts/vram_measure.py`) that:
   - Measures VRAM via torch.cuda and nvidia-smi when available
   - Simulates concurrent user workloads for each pod role
   - Reports measurements for cold start, warmup, and under load conditions
4. Analyzed current VRAM allocations and identified discrepancies

## What was found/accomplished
- **Current estimated VRAM usage per pod (from target configurations):**
  - RP1 brain: Not explicitly targeted in pod-fleet.json (currently running qwen3-30b-a3b-awq + qwen3-4b = 29GB)
  - RP2 ears: 40GB target (currently matches target)
  - RP3 music: 37GB target (currently matches target including 6GB reserves)
  - RP4 voice: 36GB target (currently matches target)
  - RP5 stems: 16GB target (currently matches target)

- **Key findings:**
  1. All pods except RP1 brain have proper target configurations in pod-fleet.json
  2. RP1 brain has a documented discrepancy:
     - Currently deployed: qwen3-30b-a3b-awq (20GB) + qwen3-4b (9GB) = 29GB
     - Manifest role brain loads: qwen3-8b-int4 (8GB) + qwen3-14b (11GB) + qwen3-4b (9GB) = 28GB
     - AI_RESIDENT_FLEET target: qwen3.6-35b-a3b-fp8 (36GB, status: neu)
  3. The VRAM measurement script was created but could not run actual hardware measurements in this environment (no nvidia-smi, no torch)
  4. Total estimated VRAM if all pods ran simultaneously: ~152GB (far exceeding single A40 capacity)

## Files created/modified
- Created: `/mnt/wd-elements/Medien/Projekte/audioMONASTRY/scripts/vram_measure.py` - VRAM measurement utility
- Created: `/mnt/wd-elements/Medien/Projekte/audioMONASTRY/test-results/vram_measurement_FLEET-P1-011.json` (empty/error results due to missing hardware)

## Issues encountered
1. **No GPU access in current environment**: Cannot run nvidia-smi or torch.cuda measurements
2. **No actual RunPod deployment**: Cannot measure real pod behavior under load
3. **Brain pod target missing**: RP1 brain pod lacks explicit target configuration in pod-fleet.json

## What remains
### Actual work needed for FLEET-P1-011 completion:
1. **Deploy pods to actual RunPod A40 instances** (requires RP_API_KEY and proper environment)
2. **Run the VRAM measurement script** in the actual pod environment to capture:
   - Cold start VRAM (after pod boot, before any requests)
   - Warmup VRAM (after initializing models but before load)
   - Peak VRAM under load with 4 concurrent users per pod (simulating typical role workloads)
3. **Update documentation with actual measurements**:
   - Update `docs/AI_FLEET_STARTPLAN.md` VRAM-Bilanz table with measured values
   - Update `services/audiomonastry-ai-runtime/model_manifest.json` estimatedVRAM fields where needed
   - Update `deploy/runpod/pod-fleet.json` target.vramGb values
   - Update `src/config/aiInfrastructure.ts` if vLLM gpu_memory_utilization needs adjustment
4. **Resolve brain pod discrepancy**: Make a decision on which configuration to target for RP1 brain
5. **Verify all pods stay under 42GB peak VRAM** (48GB total - 6GB safety margin)
6. **Derive vLLM gpu_memory_utilization** for LM-Planer from actual measurements (for RP3 music pod)

### Deliverables for completion:
- Actual VRAM measurements (cold, warm, peak under 4-user load) for each pod
- Updated VRAM values in all relevant configuration files
- Confirmation that each pod stays under 42GB peak VRAM
- Updated documentation reflecting real measurements instead of estimates

### Environment note:
This analysis was performed in a development environment without GPU access. The VRAM measurement script is ready to run in actual pod environments where torch and nvidia-smi are available.