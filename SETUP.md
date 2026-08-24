# ocd-sku-engine — setup & verification

Fourth pm2 app on the existing EC2 box (`35.154.82.17`). Own folder, own queue.
Touches nothing in `ocd-ai-engine`, `ocd-ecomm-engine` or `ocd-tools-engine`.

Work through this in order. Each step is provable before the next one matters.

---

## 1 · Queue (AWS console)

SQS → Create queue → **Standard**

| Setting | Value |
|---|---|
| Name | `ocd-sku-jobs-queue` |
| Visibility timeout | **1800 s** |
| Message retention | 4 days (default) |
| Receive message wait time | 20 s |

Record the URL. It should be:
`https://sqs.ap-south-1.amazonaws.com/539247475467/ocd-sku-jobs-queue`

## 2 · IAM

**Lambda** — add inline policy `sku-sqs-send` to `ocdLambdaRole53404fd1-dev`:
`sqs:SendMessage` on `arn:aws:sqs:ap-south-1:539247475467:ocd-sku-jobs-queue`.

**EC2** — the instance role needs `s3:GetObject` on the bucket. The engine reads
private SKU images directly; `PutObject` alone is not enough. Verify empirically
before assuming, and add a policy only on `AccessDenied`:

```bash
aws s3api head-object \
  --bucket video-template-bucket-20241209-cloudshell-user \
  --key sku-images/<username>/<skuId>/<file>.jpg --region ap-south-1
```

SQS receive on the EC2 side proved broad for the other queues — test first.

## 3 · Deploy the engine

```bash
scp -r ocd-sku-engine ubuntu@35.154.82.17:~/
ssh ubuntu@35.154.82.17
cd ~/ocd-sku-engine
npm install                    # sharp is optional; a native build failure is survivable
nano ecosystem.config.js       # paste ANTHROPIC_API_KEY / OPENAI_API_KEY from another engine
                               # confirm PRODUCT_SKUS_TABLE matches app.js
npm run check                  # node --check on every file
pm2 start ecosystem.config.js && pm2 save
pm2 logs ocd-sku-engine --lines 30 --nostream
```

Boot log must print `Queue: …/ocd-sku-jobs-queue`, then go quiet. If the queue
URL is wrong the process **exits** — that is the guard doing its job, not a bug.
No grep ritual needed here: `worker.js` refuses any queue not ending in
`/ocd-sku-jobs-queue`.

```bash
pm2 status                     # expect four apps, three of them untouched
```

## 4 · Verify the model id live

`LISTED ≠ CALLABLE`. From the box, before trusting the default:

```bash
export ANTHROPIC_API_KEY=$(node -e "console.log(require('./ecosystem.config.js').apps[0].env.ANTHROPIC_API_KEY)")
curl -s https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-opus-4-7","max_tokens":16,"messages":[{"role":"user","content":"say OK"}]}' | head
```

Paste the evidence line into the tracker. Only a verified id may be the default.

## 5 · Lambda routes

Paste `lambda/sku_analysis_routes.js` into `ocddevlocal/src/app.js` after the
existing PRODUCT SKUs block. Add `SKU_JOBS_SQS_QUEUE_URL` to the Lambda env.

```bash
amplify push --yes function ocddevlocal      # pull first — shared app.js
```

## 6 · Prove it end to end

```bash
TOKEN="<user JWT from DevTools>"
API="<ocddevlocal api base>"
SKU="sku_xxx"                                # an existing SKU with ≥1 image

curl -s -X POST "$API/api/skus/$SKU/analyse" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'
# → { "success": true, "jobId": "sku_...", "imageCount": n }

pm2 logs ocd-sku-engine --lines 60 --nostream
# expect, in order:
#   ── job sku_... · sku ... · user ...
#   attached N image(s), X.XX MB after downscale
#   [agentCall] anthropic/claude-opus-4-7 · N image(s) · ~M approx prompt tokens
#   [agentCall] usage: {...} · stop=end_turn · NNNNNms
#   AI_analysis now has 1 entry
#   ✓ job sku_... complete in NNNNNms

curl -s "$API/api/skus/$SKU/analysis/status?jobId=sku_..." -H "Authorization: Bearer $TOKEN"
curl -s "$API/api/skus/$SKU/analysis" -H "Authorization: Bearer $TOKEN" | head -c 2000
```

Read the JSON before judging anything. The first pass is about shape and
provenance tags, not about whether the copy is good.

```bash
aws dynamodb get-item --table-name ProductSKUs \
  --key '{"userId":{"S":"<username>"},"skuId":{"S":"'"$SKU"'"}}' \
  --region ap-south-1 --query 'Item.{status:analysisStatus,latest:latestAnalysisId}' --output json
```

---

## Diagnostics

| Symptom | Cause |
|---|---|
| Process exits at boot with `refusing to poll` | Queue URL in `ecosystem.config.js` is not the SKU queue |
| `ANTHROPIC_API_KEY is not set` although it is in the file | pm2 kept the old env snapshot — `pm2 delete ocd-sku-engine && pm2 start ecosystem.config.js && pm2 save` |
| `Could not read any image from S3` | Instance role is missing `s3:GetObject` (step 2) |
| `returned EMPTY content with stop reason "length"` | Reasoning-token starvation — raise `SKU_ANALYSER_MAX_TOKENS` |
| `No complete JSON object … likely truncated` | Same cause, one stage later |
| Job stuck at `queued` forever | Lambda sent to a different queue, or pm2 app is down |

## Env changes

```bash
cd ~/ocd-sku-engine
cp ecosystem.config.js ecosystem.config.js.bak      # the only copy of the keys
nano ecosystem.config.js
pm2 delete ocd-sku-engine && pm2 start ecosystem.config.js && pm2 save
```

Prompt-only edits (`engine/prompts/skuAnalyser.js`) need just
`pm2 restart ocd-sku-engine` — bump `PROMPT_VERSION` when you do, so you can
tell which cards were built by which prompt.
