// Enterprise knowledge foundation host exports: the supported boundary for a
// bundled knowledge adapter plugin (e.g. LightRAG) to register its foundation
// adapter with the core registry, mirroring the memory-core host facades.
export { registerEnterpriseKnowledgeFoundation } from "../enterprise/knowledge.js";
export type {
  KnowledgeDocumentRemovalOutcome,
  KnowledgeDocumentStatus,
  KnowledgeDocumentUploadOutcome,
  KnowledgeFoundationAdapter,
  KnowledgeFoundationConnectionResult,
  KnowledgeFoundationDescriptor,
  KnowledgeFoundationDocument,
  KnowledgeFoundationKind,
  KnowledgeSnippet,
} from "../enterprise/types.js";
