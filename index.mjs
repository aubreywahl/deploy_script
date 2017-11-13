import dotenv from 'dotenv'
import axios from 'axios'
import m from 'mustache'
import fs from 'fs'
import semver from 'semver'
import moment from 'moment'
import cp from 'child_process'
import assert from 'assert'

dotenv.config()


function envman(key, value) {
  const command =  `envman add --key ${key} --value '${value}'`
  if (DISABLE_REAL_ENVMAN) {
    console.log(command)
  } else {
    cp.execSync(command)
  }
}

const {
  BITRISE_API_TKN,
  BITRISE_APP_SLUG,
  BUILD_TRIGGER_TIMESTAMP,
  BITRISE_APP_TITLE,
  BITRISE_GIT_TAG,
  BITRISE_GIT_COMMIT,
  BITRISE_GIT_MESSAGE, // the commit message
  S3_DEPLOY_STEP_EMAIL_READY_URL, // for linking to ios ipa build (only useful for iphones)
  S3_UPLOAD_STEP_URL, // for linking to android apk build
  DISABLE_REAL_ENVMAN, // for testing
} = process.env


if (!BITRISE_API_TKN) {
  throw new Error("BITRISE_API_TKN not set")
} else if (!BITRISE_GIT_TAG) {
  throw new Error("BITRISE_GIT_TAG not set")
}


const tag_major = semver.major(BITRISE_GIT_TAG)
const tag_minor = semver.minor(BITRISE_GIT_TAG)
const tag_patch = semver.patch(BITRISE_GIT_TAG)

// gets properly formated sorting range based on this
// commit's GIT_TAG. 
//  e.g. '1.2.x' => '>=1.3.0 <1.4.0'
const patch_version_range = semver.validRange(`${tag_major}.${tag_minor}.x`)

// to to Array.filter to get all builds with same major and minor
function bitriseBuildTagFilter(a){
  return a.status_text === 'success' &&
         a.tag && 
         semver.satisfies(a.tag, patch_version_range) 
}

// pass to Array.sort to get a list of builds, descending by tag, build_number
function bitriseBuildTagCompare(a,b) {
  return semver.rcompare(a.tag, b.tag) || b.build_number - a.build_number
}

const bitrise = axios.create({
  baseURL: 'https://api.bitrise.io/v0.1/',
  headers: {'Authorization': `token ${BITRISE_API_TKN}`}
})

async function runStuff() {
  const buildsRes = await bitrise.get(`apps/${BITRISE_APP_SLUG}/builds`)
  
  const bitriseData = buildsRes && buildsRes.data &&buildsRes.data.data

  // sanity check
  assert(bitriseData)
  // assert(bitriseData.tag) // prolly should not check this
  assert(bitriseData.build_number)


  // get builds with same major and minor in descending order (by patch)
  const builds = (
    bitriseData
  ).filter( 
    bitriseBuildTagFilter
  ).sort(
    bitriseBuildTagCompare
  )
  
  console.log(builds)

  // console.log(buildsRes.data.data)
}


async function isNewestRelease() {
  
  const buildsRes = await bitrise.get(`apps/${BITRISE_APP_SLUG}/builds`)
  
  const bitriseData = buildsRes && buildsRes.data && buildsRes.data.data

  // sanity check
  assert(bitriseData, "no data fetched")
  assert(bitriseData[0].build_number, "no build_number, the bitrise api may have changed")

  // get builds with same major and minor in descending order (by patch)
  const builds = (
    bitriseData
  ).filter(
    (a) => a.status_text === 'success' &&
           a.tag
  ).sort(
    bitriseBuildTagCompare
  )
    
  return semver.gte(BITRISE_GIT_TAG, builds[0].tag)

}



// runStuff()
export default function doIt() {
  const ios = S3_DEPLOY_STEP_EMAIL_READY_URL ? {
    url: S3_DEPLOY_STEP_EMAIL_READY_URL,
  } : null

  const android = S3_UPLOAD_STEP_URL ? {
    url: S3_UPLOAD_STEP_URL,
  } : null

  const template = fs.readFileSync('template.mst', 'utf8')

  const appPage = m.render(template, {
    gitTag: `v${semver.clean(BITRISE_GIT_TAG)}`,
    gitMessage: BITRISE_GIT_MESSAGE,
    gitCommit: BITRISE_GIT_COMMIT,
    releaseDate: moment().format("MMM Do YYYY, h:mm:ss a"),
    ios,
    android,
  })

  const appName = process.argv[2].trim().replace(/\s+/, " ").split(/\s/).join("_")

  const fn = `${appName}_v${tag_major}-${tag_minor}-${tag_patch}.html`
  fs.writeFileSync(fn, appPage)
  
  envman('GENERATED_HTML_FN', fn)

  isNewestRelease().then( r => {
    if (r) {
      envman('PROMOTE_APP', 'TRUE')
    } else {
      console.log("nah don't promote this build to the top!")
    }
  })  
}


// console.log(BITRISE_API_TKN)