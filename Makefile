.PHONY: install update dry-run test test-integration check

install:
	./install.sh

update: install

dry-run:
	./install.sh --dry-run

test:
	npm --prefix sanbi test

test-integration:
	npm --prefix sanbi run test:integration

check: test
	git diff --check
