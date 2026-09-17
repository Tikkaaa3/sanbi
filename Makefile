.PHONY: install update dry-run test test-sanbi test-hermes test-integration check

install:
	./install.sh

update: install

dry-run:
	./install.sh --dry-run

test: test-sanbi test-hermes

test-sanbi:
	npm --prefix sanbi test

test-hermes:
	python -m unittest discover -s hermes/plugins/sanbi-readonly/tests -p "test_*.py"

test-integration:
	npm --prefix sanbi run test:integration

check: test
	node --check scripts/install.mjs
	python -c "from pathlib import Path; [compile(p.read_text(encoding='utf-8'), str(p), 'exec') for p in Path('hermes/plugins/sanbi-readonly').rglob('*.py')]"
	git diff --check
