---
'@yaacovcr/transform': patch
---

Change main export to `transform` from `transformResult`.

Instead of processing an existing result, the function delegates the request directly to the underlying service using a gateway-style approach.
