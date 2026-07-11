import type { OutboundMessage } from "@carememory/im-core";
import type { TemplateContext, TemplateResolver } from "@carememory/engine";
import {
  WHATSAPP_TEMPLATES,
  buildTemplateVariables,
  selectTemplate,
} from "@carememory/im-whatsapp";

export const whatsappTemplateResolver: TemplateResolver = {
  resolve(message: OutboundMessage, context: TemplateContext) {
    const templateKey = selectTemplate(message);
    const template = WHATSAPP_TEMPLATES[templateKey];
    const variables = buildTemplateVariables(templateKey, message, {
      nickname: context.nickname,
      firstName: context.firstName ?? context.nickname,
    });

    return {
      templateKey,
      templateVariables: variables,
    };
  },
};
