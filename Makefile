.PHONY: test-demo demo-chain demo-setup demo-app

test-demo:
	rm -rf txtx.yml runbooks
	anchor test -- --features demo

# demo-setup once per fresh network, then demo-app.
demo-chain:
	anchor build -- --features demo
	surfpool start -y --host 0.0.0.0

demo-setup:
	npx ts-node --transpile-only scripts/setup-demo.ts

demo-app:
	npm run app
