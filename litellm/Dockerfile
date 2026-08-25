# `main-stable` is LiteLLM's stable channel. Do NOT use `main-latest` — that
# tracks the main branch and can pull an untested build on any redeploy.
# For fully reproducible builds, pin the digest instead, e.g.
#   FROM docker.litellm.ai/berriai/litellm@sha256:1f16117e4a5707116729c3dea53505e5b2fabe7c63fe6ab02c046a9b42b222fe
# (that digest is the build verified working on 2026-08-14).
FROM docker.litellm.ai/berriai/litellm:main-stable

COPY config.yaml /app/config.yaml

# The base image sets ENTRYPOINT ["docker/prod_entrypoint.sh"], which would
# receive the CMD below as arguments and fail with "Unknown command: sh".
# Reset it so CMD runs directly. The shell form is required so ${PORT}
# (injected by Railway) is expanded at runtime.
ENTRYPOINT []
CMD ["sh", "-c", "litellm --config /app/config.yaml --host 0.0.0.0 --port ${PORT:-4000}"]
