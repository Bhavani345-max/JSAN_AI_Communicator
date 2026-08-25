FROM node:22-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The database package is a file: dependency of the backend, so it has to be in
# place before npm install can resolve the link.
COPY database/ ./database/
COPY backend/package*.json ./backend/
RUN cd backend && npm install --omit=dev
COPY backend/ ./backend/
COPY --from=frontend /app/frontend/dist ./frontend/dist

# su-exec drops root to `node` in the entrypoint after it has fixed ownership
# of the mounted volume. Alpine ships it as a 20KB static binary; gosu is the
# same tool for glibc images.
RUN apk add --no-cache su-exec

# Seeds the mount point so a volume the runtime initialises from the image
# inherits the right owner. docker-entrypoint.sh handles the other case, where
# the volume is mounted root-owned over the top of this.
RUN mkdir -p /data && chown node:node /data

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# chmod rather than trusting the source mode. A Windows checkout has no
# POSIX execute bit, so whether this file arrives executable depends on how
# the build context was produced: Docker Desktop on Windows hands COPY 0755
# and the image works, while Railway builds from the git index and gets
# whatever mode is recorded there. A non-executable ENTRYPOINT fails before
# the process writes a single line, so the symptom is a container that dies
# with an empty log. Setting it here makes the image correct either way.
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Stays root so the entrypoint can chown the volume; it execs `su-exec node`
# before the server starts, so the Node process itself is never root.
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "backend/src/server.js"]
