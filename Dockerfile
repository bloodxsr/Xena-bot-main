# 1. Use Node base
FROM node:20-bookworm

# 2. Install Rust, Python, and System dependencies
RUN apt-get update && apt-get install -y \
    curl \
    build-essential \
    pkg-config \
    python3 \
    python3-pip \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# 3. Create a symlink so 'python' command points to 'python3'
RUN ln -s /usr/bin/python3 /usr/bin/python

# 4. Add Rust to the path
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /usr/src/app

# 5. Install Node dependencies
COPY package*.json ./
RUN npm install

# 6. Copy all project files
COPY . .

# 7. Generate Prisma client
RUN npx prisma generate

# 8. Build the Rust binary
RUN cargo build --manifest-path raid_ml_sidecar/Cargo.toml --release

# 9. Environment Setup
ENV RAID_ML_HOST=0.0.0.0
ENV RAID_ML_PORT=8787
ENV PORT=10000

# 10. Start the process manager
CMD ["node", "scripts/run-rust-stack.js"]
