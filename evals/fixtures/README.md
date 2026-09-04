# Deterministic evaluation fixtures

The command `pnpm eval:fixtures` uses the versioned Golden Dataset with an
in-process deterministic system. It never calls a model, search provider,
database, or network. Generated reports are written to `evals/results/`.
