-include .env

.PHONY: test-demo demo-chain demo-setup demo-app

test-demo:
	rm -rf txtx.yml runbooks
	anchor test -- --features demo

# demo-setup once per fresh network (and for every new wallet), then demo-app.
#   make demo-setup
#   make demo-setup WALLETS="<landlord wallet> <tenant wallet>"  (override)
#   RPC=https://api.devnet.solana.com make demo-setup WALLETS=...   (devnet)
demo-chain:
	anchor build -- --features demo
	surfpool start -y --host 0.0.0.0 --offline

demo-setup:
	npx ts-node --transpile-only scripts/setup-demo.ts $(if $(WALLETS),$(WALLETS),$(LANDLORD_WALLET) $(TENANT_WALLET))

demo-app:
	npm run app
