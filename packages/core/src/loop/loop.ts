import { generateId } from 'ai-v5';
import type { ToolSet } from 'ai-v5';
import { ErrorCategory, ErrorDomain, MastraError } from '../error';
import { ConsoleLogger } from '../logger';
import { MastraModelOutput } from '../stream/base/output';
import type { OutputSchema } from '../stream/base/schema';
import { getRootSpan } from './telemetry';
import type { LoopOptions, LoopRun, StreamInternal } from './types';
import { workflowLoopStream } from './workflow/stream';

export function loop<Tools extends ToolSet = ToolSet, OUTPUT extends OutputSchema | undefined = undefined>({
  models,
  logger,
  runId,
  idGenerator,
  telemetry_settings,
  messageList,
  includeRawChunks,
  modelSettings,
  tools,
  _internal,
  mode = 'stream',
  outputProcessors,
  returnScorerData,
  llmAISpan,
  ...rest
}: LoopOptions<Tools, OUTPUT>) {
  let loggerToUse =
    logger ||
    new ConsoleLogger({
      level: 'debug',
    });

  if (models.length === 0 || !models[0]) {
    const mastraError = new MastraError({
      id: 'LOOP_MODELS_EMPTY',
      domain: ErrorDomain.LLM,
      category: ErrorCategory.USER,
    });
    loggerToUse.trackException(mastraError);
    loggerToUse.error(mastraError.toString());
    throw mastraError;
  }

  const firstModel = models[0];

  let runIdToUse = runId;

  if (!runIdToUse) {
    runIdToUse = idGenerator?.() || crypto.randomUUID();
  }

  const internalToUse: StreamInternal = {
    now: _internal?.now || (() => Date.now()),
    generateId: _internal?.generateId || (() => generateId()),
    currentDate: _internal?.currentDate || (() => new Date()),
  };

  let startTimestamp = internalToUse.now?.();

  const { rootSpan } = getRootSpan({
    operationId: mode === 'stream' ? `mastra.stream` : `mastra.generate`,
    model: {
      modelId: firstModel.model.modelId,
      provider: firstModel.model.provider,
    },
    modelSettings,
    headers: modelSettings?.headers ?? rest.headers,
    telemetry_settings,
  });

  rootSpan.setAttributes({
    ...(telemetry_settings?.recordOutputs !== false
      ? {
          'stream.prompt.messages': JSON.stringify(messageList.get.input.aiV5.model()),
        }
      : {}),
  });

  const { rootSpan: modelStreamSpan } = getRootSpan({
    operationId: `mastra.${mode}.aisdk.doStream`,
    model: {
      modelId: models[0]?.model?.modelId!,
      provider: models[0]?.model?.provider!,
    },
    modelSettings,
    headers: modelSettings?.headers ?? rest.headers,
    telemetry_settings,
  });

  const workflowLoopProps: LoopRun<Tools, OUTPUT> = {
    models,
    runId: runIdToUse,
    logger: loggerToUse,
    startTimestamp: startTimestamp!,
    messageList,
    includeRawChunks: !!includeRawChunks,
    _internal: internalToUse,
    tools,
    modelStreamSpan,
    telemetry_settings,
    modelSettings,
    outputProcessors,
    llmAISpan,
    ...rest,
  };

  const { stream: streamFn, model } = workflowLoopStream(workflowLoopProps);

  return new MastraModelOutput({
    model: {
      modelId: model.modelId,
      provider: model.provider,
      version: model.specificationVersion,
    },
    stream: streamFn,
    messageList,
    options: {
      runId: runIdToUse!,
      telemetry_settings,
      rootSpan,
      toolCallStreaming: rest.toolCallStreaming,
      onFinish: props =>
        rest.options?.onFinish?.({
          ...props,
          model,
        }),
      onStepFinish: props =>
        rest.options?.onStepFinish?.({
          ...props,
          model,
        }),
      includeRawChunks: !!includeRawChunks,
      output: rest.output,
      outputProcessors,
      returnScorerData,
    },
  });
}
