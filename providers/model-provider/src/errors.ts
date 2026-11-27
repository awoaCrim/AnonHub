import { defineErrors } from "@yesimbot/foundation";

export const MODEL_PROVIDER_ERRORS = defineErrors({
  model_provider_config_invalid: {
    model: "模型连接配置无效。",
    user: "模型连接配置无效，检查启用连接的协议和必填项。",
    status: 500,
  },
  model_provider_id_missing: { model: "启用的模型连接缺少提供商标识。", user: "启用的模型连接要填提供商标识。", status: 500 },
  model_provider_id_duplicate: { model: "启用的模型连接提供商标识重复。", user: "启用的模型连接提供商标识不能重复。", status: 500 },
  model_provider_embedding_unsupported: { model: "这个模型连接不支持向量嵌入。", user: "这个模型连接不支持向量嵌入。", status: 400 },
});
