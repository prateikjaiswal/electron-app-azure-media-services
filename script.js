/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for
 * license information.
 */
"use strict";

let $ = require("jquery");
const os = require("os");
const async = require("async");
const util = require("util");
const uuidv4 = require("uuid/v4");
const path = require("path");
const url = require("url");
const fs = require("fs");

const MediaServices = require("azure-arm-mediaservices");
const msRestAzure = require("ms-rest-azure");
const msRest = require("ms-rest");
const azureStorage = require("azure-storage");

const setTimeoutPromise = util.promisify(setTimeout);

// endpoint config
// make sure your URL values end with '/'

const armAadAudience = "https://management.core.windows.net/";
const aadEndpoint = "https://login.microsoftonline.com/";
const armEndpoint = "https://management.azure.com/";
const subscriptionId = "00000000-0000-0000-0000-000000000000";
const accountName ="amsaccount";
const azureLocation ="West US 2";
const aadClientId = "00000000-0000-0000-0000-000000000000";
const aadSecret ="00000000-0000-0000-0000-000000000000";
const aadTenantId ="00000000-0000-0000-0000-000000000000";
const resourceGroup ="amsResourceGroup";

// args
const outputFolder = "Temp";
const namePrefix = "prefix";

// You can either specify a local input file with the inputFile or an input Url with inputUrl.  Set the other one to null.

// const inputUrl = null;
// const inputFile = "c:\\temp\\input.mp4";

const inputFile = null;
let inputUrl =
  "https://sample-videos.com/video123/mp4/720/big_buck_bunny_720p_1mb.mp4";

const encodingTransformName = "TransformWithAdaptiveStreamingPreset";

// constants
const timeoutSeconds = 60 * 10;
const sleepInterval = 1000 * 15;
const delay = (time) => new Promise((resolve) => setTimeout(resolve, time));

let azureMediaServicesClient;
let inputExtension;
let blobName = null;

$("#sendBtn").on("click", function () {
  var url = $("#inputUrl").val();
  if (url !== "") {
    inputUrl = url;
  }
  start();
});

///////////////////////////////////////////
//     Entrypoint for sample script      //
///////////////////////////////////////////
function start() {
  msRestAzure.loginWithServicePrincipalSecret(
    aadClientId,
    aadSecret,
    aadTenantId,
    {
      environment: {
        activeDirectoryResourceId: armAadAudience,
        resourceManagerEndpointUrl: armEndpoint,
        activeDirectoryEndpointUrl: aadEndpoint,
      },
    },
    async function (err, credentials, subscriptions) {
      if (err) return console.log(err);
      azureMediaServicesClient = new MediaServices(
        credentials,
        subscriptionId,
        armEndpoint,
        { noRetryPolicy: true }
      );

      parseArguments();
      try {
        // Ensure that you have the desired encoding Transform. This is really a one time setup operation.
        console.log("creating encoding transform...");
        $("#creating-encoding-transform").text(
          "creating encoding transform..."
        );
        let adaptiveStreamingTransform = {
          odatatype: "#Microsoft.Media.BuiltInStandardEncoderPreset",
          presetName: "AdaptiveStreaming",
        };
        let encodingTransform = await ensureTransformExists(
          resourceGroup,
          accountName,
          encodingTransformName,
          adaptiveStreamingTransform
        );

        console.log("getting job input from arguments...");
        $("#getting-job").text("getting job input from arguments...");
        let uniqueness = uuidv4();
        let input = await getJobInputFromArguments(uniqueness);
        let outputAssetName = namePrefix + "-output-" + uniqueness;
        let jobName = namePrefix + "-job-" + uniqueness;
        let locatorName = "locator" + uniqueness;

        console.log("creating output asset...");
        $("#creating-output").text("creating output asset...");
        let outputAsset = await createOutputAsset(
          resourceGroup,
          accountName,
          outputAssetName
        );

        console.log("submitting job...");
        $("#submitting-job").text("submitting job...");
        let job = await submitJob(
          resourceGroup,
          accountName,
          encodingTransformName,
          jobName,
          input,
          outputAsset.name
        );

        console.log("waiting for job to finish...");
        $("#waiting").text("waiting for job to finish...");
        job = await waitForJobToFinish(
          resourceGroup,
          accountName,
          encodingTransformName,
          jobName
        );

        if (job.state == "Finished") {
          let locator = await createStreamingLocator(
            resourceGroup,
            accountName,
            outputAsset.name,
            locatorName
          );

          let urls = await getStreamingUrls(
            resourceGroup,
            accountName,
            locator.name
          );

          console.log("deleting jobs ...");
          $("#deleting").text("deleting jobs ...");
          await azureMediaServicesClient.jobs.deleteMethod(
            resourceGroup,
            accountName,
            encodingTransformName,
            jobName
          );
          // await azureMediaServicesClient.assets.deleteMethod(resourceGroup, accountName, outputAsset.name);

          let jobInputAsset = input;
          if (jobInputAsset && jobInputAsset.assetName) {
            await azureMediaServicesClient.assets.deleteMethod(
              resourceGroup,
              accountName,
              jobInputAsset.assetName
            );
          }
        } else if (job.state == "Error") {
          console.log(`${job.name} failed. Error details:`);
          console.log(job.outputs[0].error);
        } else if (job.state == "Canceled") {
          console.log(`${job.name} was unexpectedly canceled.`);
        } else {
          console.log(
            `${job.name} is still in progress.  Current state is ${job.state}.`
          );
        }
        console.log("done with sample");
        $("#done").text("done with sample!");
      } catch (err) {
        console.log(err);
      }
    }
  );
}

async function waitForJobToFinish(
  resourceGroup,
  accountName,
  transformName,
  jobName
) {
  let timeout = new Date();
  timeout.setSeconds(timeout.getSeconds() + timeoutSeconds);

  async function pollForJobStatus() {
    let job = await azureMediaServicesClient.jobs.get(
      resourceGroup,
      accountName,
      transformName,
      jobName
    );
    console.log(job.state);
    $("#processing").text(job.state.toString());
    if (
      job.state == "Finished" ||
      job.state == "Error" ||
      job.state == "Canceled"
    ) {
      return job;
    } else if (new Date() > timeout) {
      console.log(`Job ${job.name} timed out.`);
      return job;
    } else {
      await delay(sleepInterval);
      return pollForJobStatus();
    }
  }

  return await pollForJobStatus();
}

async function submitJob(
  resourceGroup,
  accountName,
  transformName,
  jobName,
  jobInput,
  outputAssetName
) {
  let jobOutputs = [
    {
      odatatype: "#Microsoft.Media.JobOutputAsset",
      assetName: outputAssetName,
    },
  ];

  return await azureMediaServicesClient.jobs.create(
    resourceGroup,
    accountName,
    transformName,
    jobName,
    {
      input: jobInput,
      outputs: jobOutputs,
    }
  );
}

async function getJobInputFromArguments(
  resourceGroup,
  accountName,
  uniqueness
) {
  if (inputFile) {
    let assetName = namePrefix + "-input-" + uniqueness;
    await createInputAsset(resourceGroup, accountName, assetName, inputFile);
    return {
      odatatype: "#Microsoft.Media.JobInputAsset",
      assetName: assetName,
    };
  } else {
    return {
      odatatype: "#Microsoft.Media.JobInputHttp",
      files: [inputUrl],
    };
  }
}

async function createOutputAsset(resourceGroup, accountName, assetName) {
  return await azureMediaServicesClient.assets.createOrUpdate(
    resourceGroup,
    accountName,
    assetName,
    {}
  );
}

async function createInputAsset(
  resourceGroup,
  accountName,
  assetName,
  fileToUpload
) {
  let asset = await azureMediaServicesClient.assets.createOrUpdate(
    resourceGroup,
    accountName,
    assetName,
    {}
  );
  let date = new Date();
  date.setHours(date.getHours() + 1);
  let input = {
    permissions: "ReadWrite",
    expiryTime: date,
  };
  let response = await azureMediaServicesClient.assets.listContainerSas(
    resourceGroup,
    accountName,
    assetName,
    input
  );
  let uploadSasUrl = response.assetContainerSasUrls[0] || null;
  let fileName = path.basename(fileToUpload);
  let sasUri = url.parse(uploadSasUrl);
  let sharedBlobService = azureStorage.createBlobServiceWithSas(
    sasUri.host,
    sasUri.search
  );
  let containerName = sasUri.pathname.replace(/^\/+/g, "");
  let randomInt = Math.round(Math.random() * 100);
  blobName = fileName + randomInt;
  console.log("uploading to blob...");
  function createBlobPromise() {
    return new Promise(function (resolve, reject) {
      sharedBlobService.createBlockBlobFromLocalFile(
        containerName,
        blobName,
        fileToUpload,
        resolve
      );
    });
  }
  await createBlobPromise();
  return asset;
}

async function ensureTransformExists(
  resourceGroup,
  accountName,
  transformName,
  preset
) {
  let transform = await azureMediaServicesClient.transforms.get(
    resourceGroup,
    accountName,
    transformName
  );
  if (!transform) {
    transform = await azureMediaServicesClient.transforms.createOrUpdate(
      resourceGroup,
      accountName,
      transformName,
      {
        name: transformName,
        azureLocation: azureLocation,
        outputs: [
          {
            preset: preset,
          },
        ],
      }
    );
  }
  return transform;
}

async function createStreamingLocator(
  resourceGroup,
  accountName,
  assetName,
  locatorName
) {
  let streamingLocator = {
    assetName: assetName,
    streamingPolicyName: "Predefined_ClearStreamingOnly",
  };

  let locator = await azureMediaServicesClient.streamingLocators.create(
    resourceGroup,
    accountName,
    locatorName,
    streamingLocator
  );

  return locator;
}

async function getStreamingUrls(resourceGroup, accountName, locatorName) {
  // Make sure the streaming endpoint is in the "Running" state.

  let streamingEndpoint = await azureMediaServicesClient.streamingEndpoints.get(
    resourceGroup,
    accountName,
    "default"
  );

  let paths = await azureMediaServicesClient.streamingLocators.listPaths(
    resourceGroup,
    accountName,
    locatorName
  );

  for (let i = 0; i < paths.streamingPaths.length; i++) {
    let path = paths.streamingPaths[i].paths[0];
    console.log("https://" + streamingEndpoint.hostName + "//" + path);
    $("#url" + i).text("https://" + streamingEndpoint.hostName + "//" + path);
  }
}

function parseArguments() {
  if (inputFile) {
    inputExtension = path.extname(inputFile);
  } else {
    inputExtension = path.extname(inputUrl);
  }
}
