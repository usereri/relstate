.PHONY: test-demo demo-chain demo-setup demo-app

# `surfpool start` drops txtx.yml + runbooks/ in the repo root, and while they exist
# `anchor test` starts a network with the program NOT deployed (every test fails).
# They are gitignored and regenerated, so clear them before testing.
test-demo:
	rm -rf txtx.yml runbooks
	anchor test -- --features demo

# Local network for the frontend demo (Surfpool deploys target/deploy/relstate.so).
# Run demo-setup once per fresh network, then demo-app.
demo-chain:
	anchor build -- --features demo
	surfpool start -y --host 0.0.0.0

demo-setup:
	npx ts-node --transpile-only scripts/setup-demo.ts

demo-app:
	npm run app
