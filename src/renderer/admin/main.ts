import { mount } from 'svelte'
import '../lib/ui.css'
import Admin from './Admin.svelte'

const app = mount(Admin, { target: document.getElementById('app')! })

export default app
