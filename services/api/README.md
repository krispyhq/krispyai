# @krispy/api

Hono + [`@hono/zod-openapi`](https://github.com/honojs/middleware/tree/main/packages/zod-openapi) HTTP API. Zod schemas are the single source of truth for **both** request validation and the generated OpenAPI doc.

```bash
bun --filter @krispy/api dev     # http://localhost:3001  (port: API_PORT, default 3001)
bun --filter @krispy/api typecheck
```

## Routes

| Method | Path            | Notes                                             |
| ------ | --------------- | ------------------------------------------------- |
| GET    | `/health`       | Liveness                                          |
| GET    | `/openapi.json` | Generated OpenAPI 3.1 document                    |
| GET    | `/docs`         | Swagger UI (reads `/openapi.json`)                |
| \*     | `/api/auth/*`   | Better Auth handler (`@krispy/auth`)               |
| GET    | `/me`           | **Protected** — current user, `401` if signed out |
| GET    | `/posts`        | List                                              |
| POST   | `/posts`        | Create (`NewPost`)                                |
| GET    | `/posts/{id}`   | Read (`404` if missing)                           |
| PATCH  | `/posts/{id}`   | Update                                            |
| DELETE | `/posts/{id}`   | Delete (`204`)                                    |

## Wiring to `libs/`

`posts.ts` imports `db`, `posts`, `eq` from `@krispy/db`; `index.ts` mounts `@krispy/auth`.
`src/stack-contract.d.ts` declares the exact surface this service expects from those
packages so it typechecks in isolation while `libs/` is built in parallel — the real
published types supersede it once the workspace packages ship.

## Add a resource

Copy `posts.ts`: define zod schemas, `createRoute(...)` per operation, a `repo` over
`@krispy/db`, then `app.openapi(route, handler)` in `index.ts`. It appears in `/docs` automatically.
