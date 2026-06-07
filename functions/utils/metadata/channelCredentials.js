import { findConfiguredChannel, loadChannelConfig } from './channelConfig.js';

export async function resolveS3Credentials(db, env, metadata = {}) {
  const channel = await loadConfiguredChannel(db, env, 's3', metadata);
  if (channel) {
    return {
      source: 'config',
      endpoint: channel.endpoint,
      region: channel.region || 'auto',
      bucketName: channel.bucketName,
      pathStyle: channel.pathStyle || false,
      accessKeyId: channel.accessKeyId,
      secretAccessKey: channel.secretAccessKey,
      cdnDomain: channel.cdnDomain || '',
      key: metadata.S3FileKey,
    };
  }

  return missingCredentials({
    endpoint: '',
    region: 'auto',
    bucketName: '',
    pathStyle: false,
    accessKeyId: '',
    secretAccessKey: '',
    cdnDomain: '',
    key: metadata.S3FileKey,
  });
}

async function loadConfiguredChannel(db, env, groupName, metadata = {}) {
  const uploadConfig = await loadChannelConfig(db, env, `${groupName} credentials`);
  return findConfiguredChannel(uploadConfig, groupName, metadata);
}

function missingCredentials(fields) {
  return {
    source: 'missing',
    ...fields,
  };
}
