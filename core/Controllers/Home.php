<?php

namespace Core\Controllers;

class Home extends BaseController
{
    public function index()
    {
        // test database connection
        $db = db_connect();
        if ($db->connect()) {
            echo 'Database connected successfully';
        } else {
            echo 'Database connection failed';
        }

      //return view('welcome_message');
    }
}
