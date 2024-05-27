<?php

namespace Core\Controllers;

use CodeIgniter\Controller;

class Home extends BaseController
{
    public function index()
    {
        return view('welcome_message');
    }
}
