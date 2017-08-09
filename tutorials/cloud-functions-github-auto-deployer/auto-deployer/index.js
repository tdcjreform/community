'use strict';

const crypto = require('crypto');
const downloadGitRepo = require('download-git-repo');
const fs = require('fs');
const google = require('googleapis');
const path = require('path');
const randomstring = require('randomstring');
const storage = require('@google-cloud/storage')();
const zipFolder = require('zip-folder');

// config.json contain all the required information for code running
const config = require('./config2.json');

const bucket = storage.bucket(config.stageBucket);
const PROJECT_ID = process.env.GCLOUD_PROJECT;

/**
 * Clone the github repository.
 *
 * @param {string} repository The repository to download.
 * @param {string} destination The location to write the repository.
 */
function downloadRepo (repository, destination) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading ${repository} to ${destination}`);
    downloadGitRepo(repository, destination, (err) => {
      if (err) {
        console.error(`Error downloading the ${repository} repository`, err);
        reject(err);
      } else {
        console.log(`Successfully downloaded the ${repository} repository`);
        resolve(destination);
      }
    });
  });
}

/**
 * Create a zip archive of the downloaded repository.
 *
 * @param {string} directory The location of the downloaded repository.
 */
function zipDir (directory) {
  return new Promise((resolve, reject) => {
    // The autogenerated random name for the zip file.
    const archive = `/tmp/${randomstring.generate(13)}.zip`;
    console.log(`Zipping directory ${directory} to ${archive}`);
    zipFolder(directory, archive, (err) => {
      if (err) {
        console.log(`Error zipping ${directory} into ${archive}`, err);
        reject(err);
      } else {
        console.log(`Successfully zipped ${directory} into ${archive}`);
        resolve(archive);
      }
    });
  });
}

/**
 * Upload the archive to Google Cloud Storage.
 *
 * @param {string} archive The archive to upload.
 */
function uploadArchive (archive) {
  console.log(`Uploading archive ${archive}`);
  // Upload the local zip file in your bucket.
  return bucket.upload(archive)
    .then(() => {
      console.log(`Successfully uploaded ${archive}`);
      cleanup();
      return archive;
    })
    .catch((err) => {
      console.log(`Error uploading ${archive}`, err);
      cleanup();
      return Promise.reject(err);
    });

  function cleanup (archive) {
    try {
      // Attempt to cleanup local archive
      fs.unlinkSync(archive);
    } catch (err) {
      // Ignore error
    }
  }
}

let client;

function getClient () {
  if (client) {
    return Promise.resolve(client);
  }

  return new Promise((resolve, reject) => {
    google.auth.getApplicationDefault((err, authClient, projectId) => {
      if (err) {
        reject(err);
        return;
      }
      if (authClient.createScopedRequired && authClient.createScopedRequired()) {
        authClient = authClient.createScoped(['https://www.googleapis.com/auth/cloud-platform']);
      }
      client = google.cloudfunctions({
        version: 'v1beta2',
        auth: authClient
      });
      resolve(client);
    });
  });
}

function pollOperation (gcf, operation) {
  return new Promise((resolve, reject) => {
    gcf.operations.get({
      name: operation.name
    }, (err, _operation) => {
      if (err) {
        reject(err);
      } else if (_operation.done) {
        console.log(`Successfully deployed ${_operation.response.name}`);
        resolve(_operation.response);
      } else {
        setTimeout(() => {
          pollOperation(gcf, operation).then(resolve, reject);
        }, 500);
      }
    });
  });
}

function createOrUpdateFunction (gcf, location, resource) {
  return new Promise((resolve, reject) => {
    gcf.projects.locations.functions.create({ resource, location }, (err, operation) => {
      if (err && err.errors && err.errors[0] && err.errors[0].reason === 'alreadyExists') {
        // If the function already exists, update it
        gcf.projects.locations.functions.update({ resource, name: resource.name }, (err, operation) => {
          if (err) {
            console.error(`Failed to update function ${resource.name}`, err);
            reject(err);
          } else {
            console.log(`Successfully started update operation for ${resource.name}`);
            resolve(operation);
          }
        });
      } else if (err) {
        console.error(`Failed to create function ${resource.name}`, err);
        reject(err);
      } else if (err == null) {
        console.log(`Successfully started create operation for ${resource.name}`);
        resolve(operation);
      }
    });
  });
}

/**
 * Deploy the given function.
 *
 * @param {string} archive The local function archive.
 * @param {name} name The name of the function to deploy.
 */
function deployFunction (archive, name) {
  let gcf;

  console.log(`Deploying function ${name} with ${archive}`);

  return getClient()
    .then((_gcf) => {
      gcf = _gcf;
      const location = `projects/${PROJECT_ID}/locations/${config.location}`;
      const resource = {
        sourceArchiveUrl: `gs://${config.stageBucket}/${path.parse(archive).base}`,
        name: `${location}/functions/${name}`,
        httpsTrigger: {}
      };

      return createOrUpdateFunction(gcf, location, resource);
    })
    .then((operation) => pollOperation(gcf, operation));
}

/**
 * Match deployments against the current commit.
 *
 * @param {string} repository The full name of the repository.
 */
function getCurrentDeployments (repository) {
  return Promise.resolve()
    .then(() => {
      config.currentDeployments = config.deployments.filter((deployment) => {
        return deployment.repository === repository;
      });

      if (!config.currentDeployments.length) {
        throw new Error(`No matching deployments for ${repository}.`);
      }
    });
}

/**
 * Validates the request.
 * See https://developer.github.com/webhooks/securing.
 *
 * @param {object} req
 */
function validateRequest (req) {
  return Promise.resolve()
    .then(() => {
      const digest = crypto
        .createHmac('sha1', config.secretToken)
        .update(JSON.stringify(req.body))
        .digest('hex');

      if (req.headers['x-hub-signature'] !== `sha1=${digest}`) {
        const error = new Error('Unauthorized');
        error.statusCode = 403;
        throw error;
      } else {
        console.log('Request validated.');
      }
    });
}

/**
 * The entire proceess starting from cloning the repository and ending with
 * deploying the function.
 *
 * @param {Object} req Cloud Function request context.
 * @param {Object} res Cloud Function response context.
 */
exports.githubAutoDeployer = (req, res) => {
  const user = req.body.repository.owner.name;
  const repo = req.body.repository.name;
  const repository = `${user}/${repo}`;

  // Validate the request
  return validateRequest(req)
    // Find releveant deployments for the current commit and set them on the
    // config object
    .then(() => getCurrentDeployments(repository))
    // Download the repository
    .then(() => downloadRepo(repository, `/tmp/${repo}`))
    .then((directory) => {
      // Create a zip archive for each deployment
      return Promise.all(
        config.currentDeployments
          .map((deployment) => zipDir(path.join(directory, deployment.path)))
      );
    })
    .then((archives) => {
      // Upload the zip archive for each deployment
      return Promise.all(
        archives.map((archive) => uploadArchive(archive))
      );
    })
    .then((archives) => {
      // Deploy each function
      return Promise.all(
        archives.map((archive, i) => deployFunction(archive, config.currentDeployments[i].functionName))
      );
    })
    .then((results) => {
      results.forEach((result, i) => {
        result.deployment = config.currentDeployments[i];
      });

      // Respond with the result for each deployment
      res
        .status(200)
        .send(results)
        .end();
    })
    .catch((err) => {
      console.error(err.stack);
      res
        .status(err.statusCode ? err.statusCode : 500)
        .send(err.message)
        .end();
    });
};
