import { resolve } from "node:path";

import { RunRepository } from "@insightforge/db";
import {
  DefaultDocumentParser,
  DocumentIngestor,
  OpenAiEmbeddingModel,
  PostgresDocumentStore,
} from "@insightforge/retrieval";

import { getDatabaseConnection } from "./database";
import { LocalObjectStorage } from "./local-object-storage";
import { S3ObjectStorage } from "./s3-object-storage";
import { UploadService } from "./upload-service";

let service: UploadService | undefined;

const createStorage = () => {
  const bucket = process.env.OBJECT_STORAGE_BUCKET?.trim();
  const endpoint = process.env.OBJECT_STORAGE_ENDPOINT?.trim();
  const accessKeyId = process.env.OBJECT_STORAGE_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY?.trim();
  const usesRemoteStorage = Boolean(endpoint || accessKeyId || secretAccessKey);
  if (!usesRemoteStorage) {
    return new LocalObjectStorage(
      process.env.UPLOAD_STORAGE_DIR?.trim() ||
        resolve(process.cwd(), ".data/uploads"),
    );
  }
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("OBJECT_STORAGE_CONFIG_INCOMPLETE");
  }
  return new S3ObjectStorage({
    bucket,
    region: process.env.OBJECT_STORAGE_REGION?.trim() || "auto",
    endpoint,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: process.env.OBJECT_STORAGE_FORCE_PATH_STYLE === "true",
  });
};

export const getUploadService = (): UploadService => {
  if (service) return service;
  const apiKey =
    process.env.EMBEDDING_API_KEY?.trim() || process.env.MODEL_API_KEY?.trim();
  if (!apiKey) throw new Error("EMBEDDING_API_KEY_REQUIRED");
  const database = getDatabaseConnection();
  const runs = new RunRepository(database.db);
  const store = new PostgresDocumentStore(database.db);
  const storage = createStorage();
  const embeddings = new OpenAiEmbeddingModel({
    apiKey,
    model: process.env.EMBEDDING_MODEL?.trim() || "text-embedding-3-small",
    baseUrl:
      process.env.EMBEDDING_BASE_URL?.trim() ||
      process.env.MODEL_BASE_URL?.trim(),
    dimensions: 1_536,
  });
  const ingestor = new DocumentIngestor(
    store,
    storage,
    new DefaultDocumentParser(),
    embeddings,
  );
  service = new UploadService(
    {
      async assertOwned(runId, ownerId) {
        const run = await runs.get(runId);
        if (!run || run.ownerId !== ownerId) throw new Error("RUN_NOT_FOUND");
      },
    },
    store,
    storage,
    ingestor,
  );
  return service;
};
