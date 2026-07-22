# LINE support Workflow runtime

LINE webhook and support-transition routes must statically import the workflow they pass to `start()`. Template-string or other dynamic imports prevent Workflow SDK from registering the workflow in the production deployment.

Keep orchestration modules free of Node-only dependencies. Database, encryption, AI-provider, and LINE delivery work belongs in exported `"use step"` functions in the paired `*-steps.js` module. Production workflows must only pass serializable values to steps; use a no-argument clock step for current time.

When a LINE conversation stays `AI 自動回應中`, inspect Vercel Workflow runs before changing architecture. A failed run with `WorkflowNotRegisteredError` indicates a registration/bundling regression, not a FAQ retrieval or AI-provider failure.
