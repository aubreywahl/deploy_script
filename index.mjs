// TODO(connor): Redo or deprecate and remove
import dotenv from 'dotenv'
import axios from 'axios'
import m from 'mustache'
import fs from 'fs'
import semver from 'semver'
import moment from 'moment'
import cp from 'child_process'
import assert from 'assert'


import showdown from 'showdown' // converts markdown to html string
let shdwn = new showdown.Converter()


/*
 * import our environment variables
 */
dotenv.config()
const {
  BITRISE_API_TKN,
  BITRISE_APP_SLUG,
  BUILD_TRIGGER_TIMESTAMP,
  BITRISE_APP_TITLE,
  BITRISE_GIT_TAG,
  BITRISE_GIT_COMMIT,
  BITRISE_GIT_MESSAGE,            // the commit message
  S3_DEPLOY_STEP_EMAIL_READY_URL, // url to ios ipa build
  S3_UPLOAD_STEP_URL,             // url to android apk build
  DISABLE_REAL_ENVMAN,            // for testing, should be set to true when in any non-bitrise environment
  SLACK_MSG_ICON,
  APP_NAME,
} = process.env

/*
 * quit the script if not bitrise token provided
 */
if (!BITRISE_API_TKN) {
  throw new Error("BITRISE_API_TKN not set")
} else if (!BITRISE_GIT_TAG) {
  throw new Error("BITRISE_GIT_TAG not set")
} else if (!APP_NAME || !(APP_NAME.trim().length)) {
  throw new Error("APP_NAME not set")
}


/*
 * bitrise api helper
 */
const bitrise = axios.create({
  baseURL: 'https://api.bitrise.io/v0.1/',
  headers: {'Authorization': `token ${BITRISE_API_TKN}`}
})


/* 
 * this is an alias to run envman in a bitrise environment.
 * envman sets environment variables.
 * see: https://github.com/bitrise-io/envman 
 */
function envman(key, value) {
  const command =  `envman add --key ${key} --value '${value}'`
  if (DISABLE_REAL_ENVMAN) {
    console.log(command)
  } else {
    cp.execSync(command)
  }
}


/* 
 * extract semver info for this release
 */
const tag_major = semver.major(BITRISE_GIT_TAG)
const tag_minor = semver.minor(BITRISE_GIT_TAG)
const tag_patch = semver.patch(BITRISE_GIT_TAG)


/*
 * goes through all previous successful bitrise builds to see
 * if the current release is the neweset! 
 * returns true or false
 */
async function isNewestRelease() {
  
  const buildsRes = await bitrise.get(`apps/${BITRISE_APP_SLUG}/builds`)
  
  const bitriseData = buildsRes && buildsRes.data && buildsRes.data.data

  // sanity check
  assert(bitriseData, "no data fetched")
  assert(bitriseData[0].build_number, "no build_number, the bitrise api may have changed")

  /* 
   * list of previous builds with same major and minor in 
   * descending order (by patch number)
   */  
  const builds = (
    bitriseData
  ).filter((a) => 
    a.status_text === 'success' &&
    a.tag &&
    !semver.prerelease(a.tag)
  ).sort((a,b) => 
    semver.rcompare(a.tag, b.tag) || b.build_number - a.build_number
  )

  return builds && builds.length > 0 ? semver.gte(BITRISE_GIT_TAG, builds[0].tag) : true

}

async function main() {

  const ios = S3_DEPLOY_STEP_EMAIL_READY_URL ? {
    url: S3_DEPLOY_STEP_EMAIL_READY_URL,
  } : null

  const android = S3_UPLOAD_STEP_URL ? {
    url: S3_UPLOAD_STEP_URL,
  } : null

  const template = fs.readFileSync('template.mst', 'utf8')

  const isPrerelease = semver.prerelease(BITRISE_GIT_TAG)


  /*
   * generate html string using mustache
   */
  const appReleaseHtml = m.render(template, {
    appName: APP_NAME,
    gitTag: `v${semver.clean(BITRISE_GIT_TAG)}`,
    gitMessage: shdwn.makeHtml(BITRISE_GIT_MESSAGE),
    gitCommit: BITRISE_GIT_COMMIT,
    releaseDate: moment().format("MMM Do YYYY, h:mm:ss a"),
    isPrerelease,
    ios,
    android,
    iconUrl: SLACK_MSG_ICON,
    isHappiness: BITRISE_APP_SLUG === '62311798cbc9e28b', // Watup tech debt!
  })

  const appName = APP_NAME.trim().replace(/\s+/, " ").split(/\s/).join("_")

  const prereleaseDecoration = isPrerelease ? `_${isPrerelease.join('-')}` : ''

  /*
   * name of the generated html file
   */
  const fn = `${appName}_v${tag_major}-${tag_minor}-${tag_patch}${prereleaseDecoration}.html`

  /*
   * write the html file to disk
   */
  fs.writeFileSync(fn, appReleaseHtml)
  

  const shouldPromoteApp = await isNewestRelease().then( r => {
    if (r && !isPrerelease) {
      return true
    } else {
      console.log("nah don't promote this build to the top!")
      return false
    }
  })  



  /* 
   * ===========================
   * THIS STEP IS VERY IMPORTANT !!!!!
   * ===========================
   * sets crucial environment variables used in other parts of bitrise script
   *  GENERATED_HTML_FN: the filename of the generated html file
   *  PROMOTE_APP:       if set, the bitrise script will repace app.ohmygreen.com 
   *                     link the generated html :)
   *  TARGET_BINARY:     binaries to target for Code Push
   *                     more info: https://github.com/Microsoft/code-push/tree/a0a043ed65d0e75c68f3d6ba5941d1fa070b56f1/cli#target-binary-version-parameter
   */


  /* 
   * determine the target binary for Code Push. 
   * if is a prerelease build, works like this:
   *   releasing v1.66.3-beta.3 => target binary "v1.66.3-beta.2",
   *   releasing v1.66.3-beta.1 => target binary "v1.66.3-beta.0",
   *   releasing v1.66.3-beta.0 => target binary "v1.66.3-beta.0" (again)
   *
   * more info: https://github.com/Microsoft/react-native-code-push/issues/791
   *            https://github.com/Microsoft/code-push/issues/335
   *
   * if is a production build, works like this:
   *   releasing v1.66.3 => target binary ">=v1.66.0 <v1.66.3"
   *   releasing v1.66.2 => target binary ">=v1.66.0 <v1.66.2"
   *   releasing v1.66.1 => target binary ">=v1.66.0 <v1.66.1"
   *   releasing v1.66.0 => target binary "v1.66.0"
   */
  let targetBinary;
  if (isPrerelease) {
    const prereleaseTokens =  semver.prerelease(BITRISE_GIT_TAG)
    if (prereleaseTokens.length < 2) {
      throw new Error(`ERR: poorly formatted GIT TAG for prerelease: ${BITRISE_GIT_TAG}, must look like v<maj>.<min>.<patch>-<set>.<prerelease>, e.g. v1.2.3-beta.0`)
    }
    const tag_set = prereleaseTokens[0]
    const tag_prerelease = prereleaseTokens[1]

    const prereleaseTarget = tag_prerelease === 0 ? tag_prerelease : tag_prerelease - 1
    targetBinary = `v${tag_major}.${tag_minor}.${tag_patch}-${tag_set}.${prereleaseTarget}`

  } else {
    if (tag_patch === 0) {
      targetBinary = `v${tag_major}.${tag_minor}.0`
    } else {
      targetBinary = `>=v${tag_major}.${tag_minor}.0 <v${tag_major}.${tag_minor}.${tag_patch}`
    }
  }


  envman('TARGET_BINARY', targetBinary)
  envman('GENERATED_HTML_FN', fn)
  if (shouldPromoteApp) {
    envman('PROMOTE_APP', 'TRUE')
  }

  // console.log('targetBinary:', targetBinary)
  // console.log("shouldPromote, fn:", shouldPromoteApp, "," , fn)

}

main()
