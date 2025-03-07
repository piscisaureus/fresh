fmt:
	deno fmt

lint:
	deno lint

test:
	deno test -A --no-check

dev:
	deno run -A --watch=www/static --no-check www/main.ts