# Build and run the tenant front. One stage on purpose: the app is a handful of
# files, and a multi-stage copy of node_modules would save little while adding a
# way for the runtime image to disagree with what was built.
FROM node:22-alpine

WORKDIR /app

# Dependencies first so a page edit does not reinstall them. Versions are pinned
# exactly in package.json — there is no lockfile in a freshly scaffolded repo,
# and an unpinned `next` would mean two tenants provisioned a week apart get
# different builds.
COPY package.json ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "run", "start"]
