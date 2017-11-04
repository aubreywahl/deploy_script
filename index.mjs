import dotenv from 'dotenv'
import axios from 'axios'
import m from 'mustache'
import fs from 'fs'

dotenv.config()
const BITRISE_API_TKN = process.env.BITRISE_API_TKN

if (!BITRISE_API_TKN) {
  throw new Error("BITRISE_API_TKN not set")
}


const axe = axios.create({
  baseURL: 'https://api.bitrise.io/v0.1/',
  headers: {'Authorization': `token ${BITRISE_API_TKN}`}
})

axe.get('me/apps?limit=2')
  .then(res => console.log(res.data))
  .catch(err => console.log(err.response.data))

const template = fs.readFileSync('template.mst', 'utf8')

const appPage = m.render(template, {
  test: 'yup'
})

fs.writeFile('output.html', appPage)

// console.log(BITRISE_API_TKN)