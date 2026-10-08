-include .env

.PHONY: test-demo demo-chain demo-setup demo-app program-keypair

# The program's deploy keypair is kept outside the repo, so every worktree and machine deploys
# the same program id without the private key living in git. target/ is generated and wiped by
# `cargo clean`, so the keypair is copied back in before any build. Without the file, anchor
# generates a fresh keypair and the id stops matching declare_id!.
PROGRAM_KEYPAIR ?= $(HOME)/.config/relstate/program-keypair.json

program-keypair:
	@if [ -f "$(PROGRAM_KEYPAIR)" ]; then \
		mkdir -p target/deploy; \
		cp "$(PROGRAM_KEYPAIR)" target/deploy/relstate-keypair.json; \
	else \
		echo "warning: no program keypair at $(PROGRAM_KEYPAIR)."; \
		echo "         anchor will generate a new program id, which will not match declare_id!."; \
		echo "         See \"Program keypair\" in README.md."; \
	fi

test-demo: program-keypair
	rm -rf txtx.yml runbooks
	anchor test -- --features demo

# demo-setup once per fresh network (and for every new wallet), then demo-app.
#   make demo-setup
#   make demo-setup WALLETS="<landlord wallet> <tenant wallet>"  (override)
#   RPC=https://api.devnet.solana.com make demo-setup WALLETS=...   (devnet)
demo-chain: program-keypair
	anchor build -- --features demo
	surfpool start -y --host 0.0.0.0 --offline

demo-setup:
	node scripts/setup-demo.ts $(if $(WALLETS),$(WALLETS),$(LANDLORD_WALLET) $(TENANT_WALLET))

demo-app:
	npm run app
